import type { Express } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { runMockAgentTurn } from '../agent.js';
import { runBailianAgentTurn } from '../llm/bailian.js';
import { isMockMode, isCompatEngineConfigured, getChatModel } from '../settings.js';
import { classifyIntent, INTENT_LABELS } from '../nlu.js';
import type { IntentCode } from '../db.js';
import { relayOutbound } from '../actions/outbound.js';
import * as db from '../db.js';
import { notifyChanged } from '../realtime.js';
import { ctrlOwner, serializeMessage } from './shared.js';
import { takeMusicAction } from '../music.js';

// 单轮对话引擎超时（ms）：真实引擎在此时间内未产出任何事件即判定卡死，主动中止并回退演示模式。
// 须小于前端看门狗(ENGINE_WATCHDOG_MS=150000)，否则前端会先抢跑本地兜底。
// 取值依据实测：推理型模型单轮复杂规划约 30s，叠加工具往返常达 45~60s，给到 120s 留足余量。
const CHAT_ENGINE_TIMEOUT_MS = Number(process.env.CHAT_ENGINE_TIMEOUT_MS) || 120000;

export function registerChat(app: Express): void {
app.post('/api/chat', async (req, res) => {
  const { sessionId, message, model, customerName } = req.body || {};
  if (!message || !String(message).trim()) {
    return res.status(400).json({ error: '消息不能为空' });
  }

  let session = sessionId ? db.getSession(sessionId) : undefined;
  if (!session) {
    session = db.createSession({
      id: sessionId || uuidv4(),
      title: String(message).slice(0, 24),
      model: model || getChatModel(),
      customer_name: customerName || '访客',
    });
  }
  // owner 归一：会话默认 customer_name 为占位「访客」时，统一以 'guest' 作为 agent 数据归属，
  // 对齐前端 / 调度器 / 种子数据（均用 'guest'），避免产物 / 待确认 / 活动流归属错位。
  const effectiveOwner = session.customer_name && session.customer_name !== '访客' ? session.customer_name : 'guest';

  // ---- 1. 意图标签（仅用于会话归档/统计，不再驱动作答）----
  const activeIntent: IntentCode = classifyIntent(message).intent;

  // ---- 2. 落库用户消息 ----
  const userMessageId = uuidv4();
  db.createMessage({
    id: userMessageId,
    session_id: session.id,
    role: 'user',
    content: message,
    intent: activeIntent,
  });
  if (session.intent === 'other' && activeIntent !== 'other') {
    db.updateSession(session.id, { intent: activeIntent });
  }

  // SSE
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  const send = (payload: Record<string, unknown>) => res.write(`data: ${JSON.stringify(payload)}\n\n`);

  const assistantMessageId = uuidv4();
  send({
    type: 'init',
    sessionId: session.id,
    userMessageId,
    assistantMessageId,
    intent: activeIntent,
    intentLabel: INTENT_LABELS[activeIntent],
  });

  let fullText = '';
  // 已流式吐给客户端的正文。超时/中断时 done 事件可能永远不来，但正文其实已经发出去了；
  // 兜底判断必须把它计入，否则会在真实回复之后再追加一条 mock 回复（用户看到「两条回复」）。
  let streamedText = '';
  let finalIntent: IntentCode = activeIntent;
  let toolsUsed: string[] = [];
  let usedFallback = false;
  let sdkSessionId = session.sdk_session_id ?? undefined;

  // 首轮：用首条消息作标题
  if (db.getMessagesBySession(session.id).length === 1) {
    db.updateSession(session.id, { title: String(message).slice(0, 24) });
  }

  // 选路：演示模式优先；否则走 OpenAI 兼容真实引擎（DeepSeek > 百炼）。共用同一套事件协议。
  // 原 CodeBuddy SDK 分支已于 2026-10-06 移除（SDK initialize 超时不可用），
  // 原多 Agent 编排分支同时移除（4 次模型调用、普遍 >45s，已由 MULTI_AGENT=0 长期停用）。
  const useRealEngine = !isMockMode() && isCompatEngineConfigured();
  const makeAgentGen = (forceMock = false) =>
    forceMock || isMockMode()
      ? runMockAgentTurn({ sessionId: session.id, message, model: model || session.model, customerName: effectiveOwner, intent: activeIntent })
      : runBailianAgentTurn({ sessionId: session.id, message, model: model || session.model, customerName: effectiveOwner, intent: activeIntent });

  let engineErrored = false;
  let aborted = false;
  let realGen: AsyncGenerator<any> | null = null;
  const drainGen = async (gen: AsyncGenerator<any>) => {
    for await (const ev of gen) {
      if (aborted) break;
      if (ev.type === 'text') {
        streamedText += ev.content || '';
        send({ type: 'text', content: ev.content, role: ev.role });
      } else if (ev.type === 'tool') {
        // 管家的真实动作：可视化呈现（查日程/记提醒…），可带多 Agent 角色标签
        send({ type: 'tool', name: ev.name, input: ev.input, role: ev.role });
      } else if (ev.type === 'tool_result') {
        send({ type: 'tool_result', name: ev.name, ok: ev.ok, role: ev.role });
        // 音乐：工具只把文本回给模型，真正出声在浏览器里 —— 指令随流下发
        if (ev.name === 'play_music' || ev.name === 'control_music') {
          const act = takeMusicAction();
          if (act) send({ type: 'music', ...act });
        }
      } else if (ev.type === 'ask_user') {
        // 人在环确认：把待确认问题（含可编辑的动作草稿 action_json）推到前端
        send({ type: 'ask_user', id: ev.id, question: ev.question, options: ev.options, action_json: ev.action_json, role: ev.role });
      } else if (ev.type === 'artifact') {
        // 产物交付：推给前端「产物画布」渲染（行程卡 / 报告 / 清单）
        send({ type: 'artifact', id: ev.id, title: ev.title, artifactType: ev.artifactType, action: ev.action });
      } else if (ev.type === 'done') {
        fullText = ev.fullText;
        finalIntent = ev.intent;
        toolsUsed = ev.toolsUsed;
        usedFallback = ev.fallback;
        if (ev.sdkSessionId) sdkSessionId = ev.sdkSessionId;
        if (ev.error) {
          engineErrored = true;
          send({ type: 'notice', level: 'warning', message: 'AI 响应异常，已尽力返回已有内容' });
        }
      }
    }
  };

  if (isMockMode() || isCompatEngineConfigured()) {
    try {
      realGen = makeAgentGen();
      let engineTimer: ReturnType<typeof setTimeout> | undefined;
      const timeoutP = new Promise<never>((_, reject) => {
        engineTimer = setTimeout(() => reject(new Error('ENGINE_TIMEOUT')), CHAT_ENGINE_TIMEOUT_MS);
      });
      try {
        await Promise.race([drainGen(realGen), timeoutP]);
      } finally {
        if (engineTimer) clearTimeout(engineTimer);
      }
    } catch (error: any) {
      if (error?.message === 'ENGINE_TIMEOUT') {
        aborted = true;
        engineErrored = true;
        console.warn(`[Chat] 引擎在 ${CHAT_ENGINE_TIMEOUT_MS}ms 内无响应，已自动回退演示模式`);
        if (realGen) {
          // 关键：绝不 await。生成器可能正挂在永不落地的 await（如无响应的 fetch）上，
          // 此时 .return() 同样会一直 pending，await 它会让整个请求卡死——
          // 客户端只收到 init，连兜底回复都收不到。改为 fire-and-forget。
          void realGen.return(undefined).catch(() => { /* 忽略已中止的生成器 */ });
        }
      } else {
        console.error('[Chat] Agent 执行异常：', error?.message || error);
        engineErrored = true;
      }
    }
    // 「已产出正文」必须同时看 done.fullText 与已流式吐出的 streamedText：
    // 只看前者会在「正文已吐出但未收到 done」时误判为空，从而在真实回复后再追加一条 mock（两条回复）。
    const produced = () => (fullText || streamedText).trim();

    // 真实引擎失败且未产出正文 → 自动回退 mock，保证永远有回复（不再沉默）
    if (engineErrored && !produced() && useRealEngine) {
      usedFallback = true;
      send({ type: 'notice', level: 'info', message: '真实引擎调用失败，已自动回退到演示模式生成回复；可在「设置」查看引擎状态。' });
      aborted = false; // 复位，避免影响下面的 mock 兜底生成
      try {
        await drainGen(makeAgentGen(true));
      } catch {
        if (!produced()) {
          fullText = '抱歉，AI 服务暂时出了点问题，我没能生成回复。请稍后再试一次，或者换个说法～';
          send({ type: 'text', content: fullText });
        }
      }
    } else if (engineErrored && !produced()) {
      fullText = '抱歉，AI 服务暂时出了点问题，我没能生成回复。请稍后再试一次，或者换个说法～';
      send({ type: 'text', content: fullText });
      usedFallback = true;
      send({ type: 'notice', level: 'warning', message: 'AI 服务暂不可用，请稍后重试' });
    } else if (engineErrored && produced()) {
      // 已有真实正文：保留它，只提示被截断，绝不追加第二条回复
      send({ type: 'notice', level: 'warning', message: 'AI 响应中断，已返回部分内容' });
    }
  } else {
    // 未配置 SDK 且未开启 mock：降级为通用回复（不再依赖 FAQ 知识库）
    fullText =
      '抱歉，我当前还没接入实时智能引擎，暂时无法给出个性化回答。不过我已经记下你的需求——你可以在「设置」里配置 CodeBuddy SDK 凭证，或设置 MOCK_AGENT=1 体验演示模式，接入后我就能真正帮你记提醒、查资料、办事啦。';
    send({ type: 'text', content: fullText });
    usedFallback = true;
  }

  // 续接 SDK 会话
  if (sdkSessionId && sdkSessionId !== session.sdk_session_id) {
    db.updateSession(session.id, { sdk_session_id: sdkSessionId });
  }

  // 中断时 done 可能没来：用已流式吐出的正文兜底，避免落库为空（刷新后回复消失）
  if (!fullText.trim() && streamedText.trim()) fullText = streamedText;

  // 落库助手消息
  db.createMessage({
    id: assistantMessageId,
    session_id: session.id,
    role: 'assistant',
    content: fullText.trim(),
    model: model || session.model || getChatModel(),
    intent: finalIntent,
    tool_calls: toolsUsed.length ? JSON.stringify(toolsUsed) : null,
  });
  db.updateSession(session.id, { intent: finalIntent });

  send({
    type: 'done',
    intent: finalIntent,
    intentLabel: INTENT_LABELS[finalIntent],
    fallback: usedFallback,
    tools: toolsUsed,
  });
  res.end();
  // 一轮对话结束：活动流/记忆/收件箱可能已变化，通知指挥舱刷新
  notifyChanged();
});

// 人在环：用户对待确认的高风险动作做「确认 / 取消」
app.post('/api/chat/confirm', async (req, res) => {
  const { id, decision, value } = (req.body || {}) as {
    id?: string;
    decision?: 'approve' | 'escalate' | 'defer' | 'cancel';
    value?: string;
  };
  const DECISIONS = ['approve', 'escalate', 'defer', 'cancel'] as const;
  if (!id || !decision || !DECISIONS.includes(decision)) {
    res.status(400).json({ error: '缺少 id 或 decision（应为 approve/escalate/defer/cancel）' });
    return;
  }
  const pq = db.getPendingQuestion(id);
  if (!pq) {
    res.status(404).json({ error: '未找到该待确认项（可能已处理）' });
    return;
  }
  if (pq.status !== 'pending') {
    res.status(409).json({ error: '该确认项已处理', question: db.toClientPending(pq) });
    return;
  }

  let status: 'confirmed' | 'cancelled' | 'escalated' | 'deferred';
  let resolution: string;
  let outbound: { ok: boolean; channel: string } | null = null;

  if (decision === 'approve') {
    // 改后批准：用编辑后的草稿覆盖待发送内容（若存在结构化动作）
    let actionJson = pq.action_json;
    if (value && value.trim() && actionJson) {
      try {
        const a = JSON.parse(actionJson);
        a.text = value.trim();
        actionJson = JSON.stringify(a);
        db.updatePendingAction(id, actionJson);
      } catch {
        /* 结构化解析失败则保留原文 */
      }
    }
    let action: Record<string, any> | null = null;
    try {
      action = actionJson ? JSON.parse(actionJson) : null;
    } catch {
      action = null;
    }
    const result = await relayOutbound(String(action?.text || value || pq.question), {
      owner: pq.owner,
      sessionId: pq.session_id,
      kind: 'ask_user',
      to: action?.to,
    });
    outbound = { ok: result.ok, channel: result.channel };
    status = 'confirmed';
    resolution = result.ok
      ? `✅ 已批准并执行：「${pq.question}」——已通过${result.channel === 'webhook' ? '出站 Webhook' : '邮件'}真实发出。`
      : `⚠️ 已批准，但出站发送失败（${result.error}）。已记录在本地，你可以在「设置」里配置出站通道（Webhook / SMTP）后重试。`;
  } else if (decision === 'escalate') {
    status = 'escalated';
    resolution = `👤 已转交人工：「${pq.question}」将交由人工客服跟进，我不会自动执行这一步。`;
  } else if (decision === 'defer') {
    status = 'deferred';
    resolution = `⏸️ 已稍后处理：「${pq.question}」已暂存，本轮不执行；你随时可以再让我办。`;
  } else {
    status = 'cancelled';
    resolution = `🚫 已取消：「${pq.question}」不会执行。`;
  }

  const resolved = db.answerPendingQuestion(id, status, decision);
  notifyChanged();
  // 把解析结果作为一条 assistant 消息追加进会话，形成闭环（会话可能已被清理，失败不阻断响应）
  try {
    db.createMessage({
      id: uuidv4(),
      session_id: pq.session_id,
      role: 'assistant',
      content: resolution,
      intent: 'other',
    });
  } catch (e) {
    console.warn('[Confirm] 追加解析消息失败（会话可能已不存在）：', (e as Error)?.message);
  }
  res.json({
    ok: true,
    question: resolved ? db.toClientPending(resolved) : null,
    resolution,
    outbound,
    decision,
  });
});
}
