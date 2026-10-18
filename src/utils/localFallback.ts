/**
 * 本地兜底回复（后端 /api 不可达或引擎卡死时）
 *
 * 从 `hooks/useServiceChat.ts` 的 send() 里抽出来的 ~180 行。
 * 分成两层：
 *   · `buildMockPlan()` —— **纯函数**，只做意图识别与文案/产物编排，可单测；
 *   · `runLocalMock()`  —— 驱动器，负责打字动画与写上下文，通过回调注入副作用。
 * 这样"改一句兜底文案"不需要再读懂 400 行的 send()。
 */
import type { AgentContext, AgentStep, Artifact, ChatMessage } from '../types';
import { uid } from './chatStream';

export type MockMemKind = 'note' | 'reminder' | 'plan' | 'mood' | 'fact';

export interface MockStep {
  name: string;
  role: string;
}

export interface MockPlan {
  intentLabel: string;
  plan: MockStep[];
  reply: string;
  artifact: Artifact | null;
  memKind: MockMemKind;
  makeReminder: boolean;
}

const GENERIC_PLAN: MockStep[] = [{ name: 'plan', role: 'planner' }];

/**
 * 意图识别 + 兜底内容编排。**纯函数**：同样的输入必定同样输出。
 */
export function buildMockPlan(content: string, now: Date): MockPlan {
  const tFmt = now.toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  const iso = now.toISOString();
  const art = (type: Artifact['type'], title: string, body: string): Artifact => ({
    id: 'a-' + uid(),
    owner: 'guest',
    session_id: null,
    type,
    title,
    content: body,
    version: 1,
    created_at: iso,
    updated_at: iso,
  });

  let intentLabel = '日常陪伴';
  let plan = GENERIC_PLAN;
  let memKind: MockMemKind = 'note';
  let makeReminder = false;
  let artifact: Artifact | null = null;
  let reply = `收到～「${content}」我先记在心里。\n\n你想让我**记下来**、**规划**还是**聊聊**？随时吩咐。`;

  if (/行程|旅游|周末|度假|去.{0,4}玩|游|杭州|北京|上海|攻略/.test(content)) {
    intentLabel = '行程规划';
    plan = [
      { name: 'plan', role: 'planner' },
      { name: 'web_lookup', role: 'researcher' },
      { name: 'review', role: 'critic' },
    ];
    reply = `好的，我来帮你规划「${content}」。\n\n先拆任务、查天气与景点，再让**复核智能体**把关节奏：\n\n- 任务拆解\n- 天气 / 景点检索\n- 行程草案生成`;
    artifact = art(
      'itinerary',
      '出行草案',
      'Day 1 · 抵达 + 慢游\nDay 2 · 核心景点 + 美食\nDay 3 · 收尾 + 回程\n\n（演示骨架，待联网后补全）'
    );
    memKind = 'plan';
  } else if (/提醒|记得|备忘|记一下|别忘|开会|生日|约.{0,3}点|明天|后天|下周|到时/.test(content)) {
    intentLabel = '提醒备忘';
    plan = [
      { name: 'plan', role: 'planner' },
      { name: 'set_reminder', role: 'executor' },
    ];
    reply = `已记下「${content}」✅ 我会**按时提醒**你，不会忘掉。`;
    artifact = art('note', '已记录的提醒', `「${content}」\n时间：${tFmt}\n状态：已写入管家备忘录`);
    memKind = 'reminder';
    makeReminder = true;
  } else if (/天气|温度|下雨|带伞|下雪|气温|多少度/.test(content)) {
    intentLabel = '天气查询';
    plan = [{ name: 'web_lookup', role: 'researcher' }];
    reply = `来查天气……目前数据通道还没接通。\n\n> 出门前看实时预报最稳，我先用经验提醒你带上**备用方案**。`;
  } else if (/心情|累|开心|难过|压力|焦虑|担心|害怕|孤独/.test(content)) {
    intentLabel = '心情关怀';
    plan = [
      { name: 'plan', role: 'planner' },
      { name: 'checkin_mood', role: 'executor' },
    ];
    reply = `听到了。「${content}」听起来有件在意的事。\n\n先聊聊？我不会催你做任何决定。`;
    memKind = 'mood';
  } else if (/报告|总结|周报|月报|整理|汇总|写一份/.test(content)) {
    intentLabel = '报告整理';
    plan = [
      { name: 'plan', role: 'planner' },
      { name: 'recall', role: 'researcher' },
      { name: 'review', role: 'critic' },
    ];
    reply = `收到，整理「${content}」我先把**骨架**搭出来。\n\n稍后你补充素材，就能成稿。`;
    artifact = art(
      'report',
      '报告骨架',
      '一、概览\n二、关键指标\n三、详细分析\n四、下一步建议\n\n（演示骨架）'
    );
    memKind = 'plan';
  } else if (/省|花|预算|便宜|优惠|划算|怎么买|推荐|对比/.test(content)) {
    intentLabel = '省钱参谋';
    plan = [
      { name: 'plan', role: 'planner' },
      { name: 'web_lookup', role: 'executor' },
    ];
    reply = `明白～「${content}」这种事我喜欢。\n\n先列几个常见省法，你挑顺手的：\n\n- 比价 3 家平台\n- 蹲大促 / 活动日\n- 券叠加 / 返利`;
    artifact = art(
      'checklist',
      '省钱清单',
      '☐ 比价 3 家平台\n☐ 蹲活动日 / 大促节点\n☐ 看返利 / 券叠加\n☐ 拼团 / 凑单\n\n（演示骨架）'
    );
  } else if (/搜索|查一下|是什么|怎么|为什么|什么意思|解释/.test(content)) {
    intentLabel = '信息检索';
    plan = [{ name: 'web_lookup', role: 'researcher' }];
    reply = `正在检索「${content}」……\n\n离线模式下我先给个**常识方向**的指引，更准确的答案建议联网查一下。`;
  }

  return { intentLabel, plan, reply, artifact, memKind, makeReminder };
}

export interface RunMockOptions {
  content: string;
  /** 用户主动中止（stop）时会被 abort */
  signal: AbortSignal;
  patch: (patch: Partial<ChatMessage>) => void;
  /** 写本地上下文（记忆/提醒），让仪表盘与右栏立刻看到变化 */
  applyContext: (fn: (prev: AgentContext | null) => AgentContext) => void;
  /** 兜底算「在线」，避免右下角离线提示一直亮 */
  setOnline?: () => void;
  now?: Date;
}

/**
 * 播放兜底回复：意图识别 → 步骤流（逐个 running→done）→ 流式打字 → 产物 → 写上下文。
 */
export async function runLocalMock(opts: RunMockOptions): Promise<void> {
  const now = opts.now || new Date();
  const { content, signal, patch, applyContext } = opts;
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const { intentLabel, plan, reply, artifact, memKind, makeReminder } = buildMockPlan(content, now);

  // 步骤流：逐个 running → done
  const steps: AgentStep[] = [];
  for (const ps of plan) {
    if (signal.aborted) return;
    const step: AgentStep = { id: uid(), name: ps.name, status: 'running', role: ps.role };
    steps.push(step);
    patch({ steps: [...steps] });
    await sleep(620);
    if (signal.aborted) return;
    const idx = steps.findIndex((s) => s.id === step.id);
    if (idx !== -1) steps[idx] = { ...steps[idx], status: 'done' };
    patch({ steps: [...steps] });
    await sleep(240);
  }

  // 流式打字
  for (let i = 0; i < reply.length; i += 3) {
    if (signal.aborted) return;
    patch({ content: reply.slice(0, i + 3) });
    await sleep(30);
  }

  if (artifact) patch({ artifacts: [artifact] });
  patch({ isStreaming: false, intentLabel, steps: [...steps] });

  applyContext((prev) => {
    const memory = {
      id: 'm-' + uid(),
      owner: 'guest',
      key: content.slice(0, 24),
      value: content,
      kind: memKind,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
      expire_at: null,
    } as AgentContext['memories'][number];
    const reminders = prev?.reminders ? [...prev.reminders] : [];
    if (makeReminder) {
      reminders.unshift({
        id: 'r-' + uid(),
        owner: 'guest',
        body: content,
        due_at: new Date(now.getTime() + 86400000).toISOString(),
        due_ts: now.getTime() + 86400000,
        done: 0,
        created_at: now.toISOString(),
      } as AgentContext['reminders'][number]);
    }
    return {
      owner: 'guest',
      memories: [...(prev?.memories || []), memory].slice(-50),
      reminders,
      moods: prev?.moods || [],
    };
  });

  opts.setOnline?.();
}
