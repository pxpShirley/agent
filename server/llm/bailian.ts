/**
 * 星澜 · 百炼（阿里云 DashScope / 通义千问）Reasoner
 * 通过 DashScope 的 OpenAI 兼容端点驱动真实大模型，替代演示用的 Mock 与封闭的 CodeBuddy SDK。
 *
 * 设计要点：
 * - 与 runAgentTurn / runMockAgentTurn 共用同一套 AgentEvent 契约（流式 text + tool + ask_user + done），
 *   因此对前端、确认卡、活动流零侵入。
 * - 用 function calling 让模型自主选工具，循环执行（对齐六步 ReAct），最多 MAX_AGENT_ITERATIONS 轮。
 * - 工具为「直连执行器」：镜像 tools/index.ts 的 handler（进程内落库 + 联网），不依赖 MCP。
 * - ask_user 触发人在环：创建待确认项并终止本轮，等用户在指挥舱确认/取消后再续。
 * - 流式：逐 token 产出 text；tool_calls 跨 chunk 累加后执行。
 */
import type { AgentTurnOptions, AgentEvent } from '../agent.js';
import * as db from '../db.js';
import type { IntentCode } from '../db.js';
import { activeToolDefs, execTool, askUser } from '../tools/registry.js';
import type { ToolContext } from '../tools/registry.js';
import { buildSystemPrompt, buildMemoryContext, MAX_AGENT_ITERATIONS } from '../agent.js';
import { guardBareQuestion, couldBeBareQuestion } from '../clarify.js';
import type { ClarifyCtx } from '../clarify.js';
import {
  getBailianApiKey,
  getBailianModel,
  isDeepSeekConfigured,
  getDeepSeekApiKey,
  getDeepSeekModel,
  getDeepSeekEndpoint,
} from '../settings.js';

/** DashScope OpenAI 兼容端点（可用 BAILIAN_BASE_URL 覆盖，便于私有化/代理） */
const BAILIAN_ENDPOINT =
  process.env.BAILIAN_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';

// ----------------------------------------------------------------
// OpenAI 兼容供应商解析（DeepSeek 优先，其次百炼）
// 两者协议一致（/chat/completions + function calling + SSE），共用本文件全部逻辑。
// ----------------------------------------------------------------

type CompatProviderName = 'deepseek' | 'bailian';
interface CompatProvider {
  name: CompatProviderName;
  endpoint: string;
  apiKey: string;
  model: string;
}

/**
 * 挑选模型名：仅当传入的模型名「属于」当前供应商时才采用。
 * 否则（例如会话里存着上一位供应商的模型名）回退到当前供应商默认模型，
 * 避免把 qwen-* 发给 DeepSeek（或反之）导致 400 模型不存在。
 */
function pickModel(provider: CompatProviderName, override?: string): string {
  const looksDeepSeek = /^deepseek/i.test(override || '');
  if (override && override !== 'auto') {
    const belongs = provider === 'deepseek' ? looksDeepSeek : !looksDeepSeek;
    if (belongs) return override;
  }
  return provider === 'deepseek' ? getDeepSeekModel() : getBailianModel();
}

/** 解析当前生效的供应商：DeepSeek 已配置则优先，否则百炼 */
function resolveProvider(modelOverride?: string): CompatProvider {
  if (isDeepSeekConfigured()) {
    return {
      name: 'deepseek',
      endpoint: getDeepSeekEndpoint(),
      apiKey: getDeepSeekApiKey(),
      model: pickModel('deepseek', modelOverride),
    };
  }
  return {
    name: 'bailian',
    endpoint: BAILIAN_ENDPOINT,
    apiKey: getBailianApiKey(),
    model: pickModel('bailian', modelOverride),
  };
}

// ----------------------------------------------------------------
// 工具：唯一注册表在 server/tools/registry.ts（schema 与实现同处定义）
// 本文件只负责「schema → OpenAI function 格式」的转换与调用编排，不再自己实现工具。
// ----------------------------------------------------------------

function toOpenAiTools(defs: Array<{ name: string; description: string; parameters: any }>) {
  return defs.map((d) => ({
    type: 'function',
    function: {
      name: d.name,
      description: d.description,
      parameters: d.parameters,
    },
  }));
}

// ----------------------------------------------------------------
// DashScope 流式调用（function calling 累加）
// ----------------------------------------------------------------

interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}
type StreamChunk = { kind: 'text'; content: string } | { kind: 'end'; toolCalls: ToolCall[] };

/** DeepSeek 的 deepseek-reasoner 不支持 function calling / temperature，需单独降级处理 */
function isReasoningModel(model: string): boolean {
  return /reasoner/i.test(model);
}

async function* streamCompat(
  provider: CompatProvider,
  messages: any[],
  tools: any[],
  signal: AbortSignal
): AsyncGenerator<StreamChunk> {
  const reasoning = isReasoningModel(provider.model);
  const body: Record<string, any> = {
    model: provider.model,
    messages,
    stream: true,
    // reasoner 的 max_tokens 要同时容纳思维链与正文，给足空间
    max_tokens: reasoning ? 4000 : 1500,
  };
  if (tools.length && !reasoning) body.tools = tools;
  // reasoner 不接受 temperature / top_p
  if (!reasoning) body.temperature = 0.7;

  const resp = await fetch(provider.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.apiKey}` },
    body: JSON.stringify(body),
    signal,
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`${provider.name === 'deepseek' ? 'DeepSeek' : '百炼'}接口 ${resp.status}: ${txt.slice(0, 300)}`);
  }
  const reader = resp.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let acc: ToolCall[] = [];
  let sawToolCalls = false;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      let json: any;
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }
      const delta = json?.choices?.[0]?.delta;
      if (!delta) continue;
      if (typeof delta.content === 'string' && delta.content) {
        yield { kind: 'text', content: delta.content };
      }
      if (delta.tool_calls) {
        sawToolCalls = true;
        for (const tc of delta.tool_calls as any[]) {
          const idx = tc.index ?? 0;
          if (!acc[idx]) acc[idx] = { id: '', name: '', arguments: '' };
          if (tc.id) acc[idx].id = tc.id;
          if (tc.function?.name) acc[idx].name = tc.function.name;
          if (tc.function?.arguments) acc[idx].arguments += tc.function.arguments;
        }
      }
    }
  }
  if (sawToolCalls) {
    yield { kind: 'end', toolCalls: acc.filter(Boolean).map((t) => ({ id: t.id, name: t.name, arguments: t.arguments })) };
  } else {
    yield { kind: 'end', toolCalls: [] };
  }
}

/**
 * 引擎连通性自检：用一条极短消息打一次非流式请求，验证 Key / 模型 / 端点是否可用。
 * 用于设置页「测试连接」，避免用户靠一整轮对话才能发现问题。
 */
export async function pingCompatEngine(): Promise<{
  provider: CompatProviderName;
  model: string;
  endpoint: string;
  ok: boolean;
  latencyMs: number;
  error?: string;
  sample?: string;
}> {
  const provider = resolveProvider();
  const reasoning = isReasoningModel(provider.model);
  const started = Date.now();
  const body: Record<string, any> = {
    model: provider.model,
    messages: [{ role: 'user', content: '回复两个字：可用' }],
    stream: false,
    max_tokens: reasoning ? 512 : 16,
  };
  if (!reasoning) body.temperature = 0;
  try {
    const resp = await fetch(provider.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    const txt = await resp.text().catch(() => '');
    if (!resp.ok) {
      return {
        provider: provider.name,
        model: provider.model,
        endpoint: provider.endpoint,
        ok: false,
        latencyMs: Date.now() - started,
        error: `HTTP ${resp.status} ${txt.slice(0, 200)}`,
      };
    }
    let sample = '';
    try {
      sample = String(JSON.parse(txt)?.choices?.[0]?.message?.content || '').trim().slice(0, 40);
    } catch {
      /* 解析失败不影响连通性结论 */
    }
    return {
      provider: provider.name,
      model: provider.model,
      endpoint: provider.endpoint,
      ok: true,
      latencyMs: Date.now() - started,
      sample,
    };
  } catch (e: any) {
    return {
      provider: provider.name,
      model: provider.model,
      endpoint: provider.endpoint,
      ok: false,
      latencyMs: Date.now() - started,
      error: e?.message || String(e),
    };
  }
}

// ----------------------------------------------------------------
// 对外：流式执行一次 Agent 对话轮
// ----------------------------------------------------------------

/**
 * 组装多轮对话上下文。
 * 没有这段，每轮只把「当前这一句话」发给模型，模型完全失忆——
 * 用户说「设置一个提醒」时它不知道上文在聊什么，只能空泛反问「提醒什么事？什么时候？」，显得很笨。
 * 从最近一条往前取，受条数与总字符数双重限制，避免长会话把上下文撑爆。
 */
function buildHistory(
  sessionId: string,
  current: string,
  maxTurns = 12,
  maxChars = 6000
): Array<{ role: 'user' | 'assistant'; content: string }> {
  let rows: any[] = [];
  try {
    rows = db.getMessagesBySession(sessionId);
  } catch {
    return [];
  }
  const picked: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  let chars = 0;
  const cur = String(current || '').trim();
  for (let i = rows.length - 1; i >= 0 && picked.length < maxTurns; i--) {
    const r = rows[i];
    if (r.role !== 'user' && r.role !== 'assistant') continue;
    const c = String(r.content || '').trim();
    if (!c) continue;
    // 当前这条用户消息通常已落库，跳过它，避免模型看到两遍
    if (i === rows.length - 1 && r.role === 'user' && c === cur) continue;
    if (chars + c.length > maxChars) break;
    picked.unshift({ role: r.role as 'user' | 'assistant', content: c });
    chars += c.length;
  }
  return picked;
}

/**
 * 「打开《某产物》」意图的服务端兜底。
 * 模型经常懒得调 open_artifact，转而凭对话历史复述内容——一旦历史里没有就会编造。
 * 所以这里在服务端直接把命中的产物真实内容拼进用户消息，模型照着展示即可，不可能编错。
 */
function tryFindArtifactContent(owner: string, text: string): string | null {
  if (!/打开|查看|看一下|看看|打开下|展示/.test(text)) return null;
  const m = text.match(/[《「"'『]([^《》「」"'』]{2,40})[》」"'』]/);
  const raw = m ? m[1] : text.replace(/打开|查看|看一下|看看|展示|产物|行程卡|清单|报告/g, '').trim();
  const t = String(raw || '').replace(/[《》"'「」『』\s]/g, '').replace(/产物|行程卡|清单|报告/g, '');
  if (t.length < 2) return null;
  const norm = (s: string) => String(s).replace(/[《》"'「」『』\s]/g, '');
  const all = db.getArtifacts(owner, 50);
  const hit = all.find((a) => norm(a.title).includes(t)) || all.find((a) => t.includes(norm(a.title)));
  if (!hit) return null;
  return `【系统已为你打开该产物，以下是它的真实内容，请直接展示给用户，不要再说「我帮你打开」「这次是真的」之类的话】\n标题：${hit.title}\n类型：${hit.type}\n内容：\n${hit.content}`;
}

/**
 * L0+ ①：只读工具白名单 —— 同一轮里若模型一次返回多个工具调用，
 * 仅当**全部**命中此白名单时才并发执行（Promise.all）；
 * 其余（写库 / 音乐副作用 / ask_user 中断本轮）一律保持串行，避免竞态与语义错乱。
 * 注意：新增工具时若它是纯读取，记得加进来，否则会退化成串行（安全但慢）。
 */
const READ_ONLY_TOOLS = new Set(['recall_memory', 'get_schedule', 'web_lookup', 'open_artifact']);

export async function* runBailianAgentTurn(opts: AgentTurnOptions): AsyncGenerator<AgentEvent> {
  const { sessionId, message, model, customerName, intent, systemOverride, role, skipRecord, maxIter, omitTools } = opts;
  const owner = customerName || 'guest';
  // 供应商解析：DeepSeek 优先，其次百炼；模型名会按供应商归属自动校正
  const provider = resolveProvider(model);
  const apiKey = provider.apiKey;
  if (!apiKey) {
    yield {
      type: 'done',
      fullText: '',
      intent,
      toolsUsed: [],
      fallback: true,
      error: '未配置可用的大模型 API Key（DEEPSEEK_API_KEY 或 BAILIAN_API_KEY）',
      role,
    };
    return;
  }
  const mdl = provider.model;
  // 预注入记忆必须带上本轮原话：不带就退化成「取最近 N 条」，
  // 模型拿不到相关的那几条，还是得再花一轮去调 recall_memory。
  const memoryContext = buildMemoryContext(owner, String(message || ''));
  // 工具集先算出来，提示词里的「可用能力清单」必须由它派生——两者必须同源，
  // 否则会出现「提示词禁止调用清单外的工具，而真正要用的工具恰好在清单外」。
  const toolDefs = omitTools?.length
    ? activeToolDefs(owner).filter((t) => !omitTools.includes(t.name))
    : activeToolDefs(owner);
  const system = systemOverride || buildSystemPrompt(memoryContext, toolDefs.map((t) => t.name));
  const toolsUsed: string[] = [];
  let fullText = '';
  // 护栏生成的「可点选澄清选项」（最后一轮纯文本被判为空泛反问时产出）；随 done 下发给前端
  let pendingChoices: string[] | undefined;

  // —— L0+ ② 最小 span 埋点 ——
  // 没有它，「并行执行/记忆预注入到底省了几轮」就只是感觉，无法证明也无法回归。
  // 只记四个标量，落在既有 agent_runs 表上，成本≈0。
  const startedAt = Date.now();
  const span = { iterations: 0, toolCalls: 0, parallelRounds: 0 };

  // 活动流遥测：把本轮 agent 自主动作写入 agent_runs，让指挥舱「活动流」有真实内容
  const recordRun = () => {
    if (skipRecord) return;
    try {
      db.addAgentRun({
        session_id: sessionId,
        prompt: String(message || ''),
        intent,
        tools_used: Array.from(new Set(toolsUsed)).join(','),
        outcome: 'handled',
        model: mdl,
        iterations: span.iterations,
        tool_calls_count: span.toolCalls,
        parallel_rounds: span.parallelRounds,
        latency_ms: Date.now() - startedAt,
      });
    } catch {
      /* 遥测失败不影响主流程 */
    }
  };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 180000);

  // 「打开产物」兜底：命中时把真实内容拼进用户消息，避免模型凭记忆编造
  const opened = tryFindArtifactContent(owner, String(message || ''));
  const userContent = opened ? `${String(message || '')}\n\n${opened}` : String(message || '');
  const history = buildHistory(sessionId, String(message || ''));
  const messages: any[] = [
    { role: 'system', content: system },
    ...history,
    { role: 'user', content: userContent },
  ];

  // 「空泛反问」护栏上下文：只保护「提醒/待办」一族，并带回上文说过的时间/事件做推断依据
  const clarifyCtx: ClarifyCtx = {
    message: String(message || ''),
    history: history
      .filter((m: { role: string }) => m.role === 'user')
      .map((m: { content: string }) => String(m.content || ''))
      .slice(-6),
  };

  const ctx: ToolContext = { owner, sessionId, intent };

  try {
    for (let iter = 0; iter < (maxIter ?? MAX_AGENT_ITERATIONS); iter++) {
      span.iterations = iter + 1;
      let toolCalls: ToolCall[] = [];
      // 本轮文本先攒着，不直接吐——「空泛反问」护栏要等整句到底才能判定；
      // 但在「还可能是空泛反问」的观察窗内也憋住前几个字，避免空话已经展示给用户才补救。
      // ⚠️ yield 必须在生成器顶层（闭包里不能 yield），所以这里内联，不用 emit 辅助函数。
      let iterText = '';
      let held = true; // 仍处于「可能空泛反问」的观察窗
      for await (const chunk of streamCompat(provider, messages, toOpenAiTools(toolDefs), ac.signal)) {
        if (chunk.kind === 'text') {
          iterText += chunk.content;
          if (!held) {
            fullText += chunk.content; // 已确认不是空泛反问：逐字直通
            yield { type: 'text', content: chunk.content, role };
          } else if (!couldBeBareQuestion(iterText, clarifyCtx)) {
            fullText += iterText; // 翻窗：把已攒的字一次性吐出并转直通
            yield { type: 'text', content: iterText, role };
            iterText = '';
            held = false;
          }
          // 仍在观察窗内：继续憋，不吐
        } else {
          toolCalls = chunk.toolCalls;
        }
      }

      if (!toolCalls.length) {
        // 最后一轮纯文本：落定判定。仍憋着的字若是空泛反问，用护栏生成的替代回复替换；否则原样吐出。
        if (held) {
          const fixed = guardBareQuestion(iterText, clarifyCtx);
          if (fixed.repaired) {
            fullText += fixed.text;
            yield { type: 'text', content: fixed.text, role };
            pendingChoices = fixed.choices;
          } else {
            fullText += iterText;
            yield { type: 'text', content: iterText, role };
          }
        }
        break;
      }

      // 有工具调用：本轮文本是工具前的前情提要，先把憋着的字补齐，再照常执行工具
      if (held) {
        fullText += iterText;
        yield { type: 'text', content: iterText, role };
        iterText = '';
        held = false;
      }

      // 把带 tool_calls 的助手消息回写上下文（Dash 要求 assistant 消息带 tool_calls 才能跟 tool 结果）
      messages.push({
        role: 'assistant',
        // DeepSeek 对 content=null 的 assistant 消息更严格，统一用空串
        content: fullText || '',
        tool_calls: toolCalls.map((t) => ({
          id: t.id,
          type: 'function',
          function: { name: t.name, arguments: t.arguments },
        })),
      });

      // L0+ ①：解析入参（两条分支共用），并判断是否可并发
      const parsedCalls = toolCalls.map((tc) => {
        let args: Record<string, any> = {};
        try {
          args = tc.arguments ? JSON.parse(tc.arguments) : {};
        } catch {
          args = {};
        }
        return { tc, args };
      });
      const canParallel =
        parsedCalls.length > 1 && parsedCalls.every(({ tc }) => READ_ONLY_TOOLS.has(tc.name));

      span.toolCalls += parsedCalls.length;
      if (canParallel) span.parallelRounds += 1;

      if (canParallel) {
        // —— 并发分支（仅只读工具）——
        // 先把「要调什么」全部发给前端，再一起执行，前端能更快看到意图
        for (const { tc, args } of parsedCalls) {
          toolsUsed.push(tc.name);
          yield { type: 'tool', name: tc.name, input: args, role };
        }
        const results = await Promise.all(
          parsedCalls.map(({ tc, args }) => execTool(tc.name, args, ctx)),
        );
        // 关键：tool 消息必须按 tool_calls 的**原顺序**回填，
        // 否则 tool_call_id 与 assistant.tool_calls 错位，下一轮模型会串味。
        parsedCalls.forEach(({ tc }, i) => {
          messages.push({ role: 'tool', tool_call_id: tc.id, content: results[i] });
        });
        for (const { tc } of parsedCalls) {
          yield { type: 'tool_result', name: tc.name, ok: true, role };
        }
        continue; // 进入下一轮
      }

      // —— 串行分支（含写操作 / 音乐 / ask_user 的原逻辑）——
      for (const { tc, args } of parsedCalls) {
        toolsUsed.push(tc.name);
        yield { type: 'tool', name: tc.name, input: args, role };

        // 人在环：高风险动作前确认，并终止本轮等待用户
        if (tc.name === 'ask_user') {
          // 副作用实现在注册表里（唯一一份），这里只负责拦截本轮并把确认卡推给前端
          const pq = askUser(args, ctx);
          yield {
            type: 'ask_user',
            id: pq.id,
            question: pq.question,
            options: pq.options,
            action_json: pq.action_json,
            role,
          };
          recordRun();
          clearTimeout(timer);
          yield {
            type: 'done',
            fullText: fullText.trim(),
            intent,
            toolsUsed: Array.from(new Set(toolsUsed)),
            fallback: false,
            role,
          };
          return;
        }

        const result = await execTool(tc.name, args, ctx);
        messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
        yield { type: 'tool_result', name: tc.name, ok: true, role };

        // 产物事件：Agent 通过 create/update_artifact 交付结构化对象时，推给前端「产物画布」
        if (tc.name === 'create_artifact' || tc.name === 'update_artifact') {
          try {
            const parsed = JSON.parse(result);
            if (parsed?.id) {
              yield {
                type: 'artifact',
                id: parsed.id,
                title: parsed.title || '未命名产物',
                artifactType: parsed.type || 'note',
                action: tc.name === 'create_artifact' ? 'created' : 'updated',
              };
            }
          } catch {
            /* 解析失败不阻断 */
          }
        }
      }
    }
    clearTimeout(timer);
    recordRun();
    yield {
      type: 'done',
      fullText: fullText.trim(),
      intent,
      toolsUsed: Array.from(new Set(toolsUsed)),
      fallback: false,
      role,
      choices: pendingChoices,
    };
  } catch (error: any) {
    const errMsg = error?.message || String(error);
    console.error(`[${provider.name === 'deepseek' ? 'DeepSeek' : 'Bailian'}] 调用失败：`, errMsg);
    clearTimeout(timer);
    if (!fullText.trim()) {
      yield {
        type: 'done',
        fullText: '',
        intent,
        toolsUsed: Array.from(new Set(toolsUsed)),
        fallback: true,
        error: errMsg,
        role,
      };
    } else {
      yield {
        type: 'done',
        fullText: fullText.trim(),
        intent,
        toolsUsed: Array.from(new Set(toolsUsed)),
        fallback: false,
        error: errMsg,
        role,
      };
    }
  }
}
