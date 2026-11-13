/**
 * 上下文装配器：主循环**唯一**获取上下文的出口（P1 · 2026-11-13）
 *
 * 之前四处拼装散落在 bailian.ts / agent.ts / memory.ts：
 * 记忆预算、系统提示、工具 schema、历史截断各算各的，谁也不知道别人占了
 * 多少。这里把它们收成一次调用：先算出真正要下发的固定段（并实测字符数），
 * 再由总预算扣减，剩余全给历史。
 *
 * 单一真相源纪律：
 *  · 工具 schema 的 OpenAI 适配放在本文件（toOpenAiTools），装配器用
 *    JSON.stringify(tools) 实测体积，主循环直接下发同一份 tools ——
 *    「预算里的工具体积」「提示词能力清单」「实际下发 schema」三者不会各算一份。
 *  · 记忆检索仍只在 server/memory.ts（selectMemories），这里只把它的
 *    实际产出计入总预算，不重写打分。
 *  · 历史截取只在本文件，不再有 bailian.ts 里的私有 buildHistory。
 *
 * 红线：stats 是工程遥测（成本/裁剪），只进只读 trace，绝不成段塞回 prompt。
 */
import * as db from '../db.js';
import { buildMemoryContext, buildSystemPrompt } from '../agent.js';
import { createBudget, allocate } from './budget.js';
import type { Allocation, TokenBudget } from './budget.js';

export interface ToolDef {
  name: string;
  description: string;
  parameters: any;
}

/**
 * schema → OpenAI function 格式。
 * 放在装配器里是为了让「下发的 tools」与「计量用的 toolsChars」同源；
 * 主循环不要再自己转一次。
 */
export function toOpenAiTools(defs: ToolDef[]): Array<{
  type: 'function';
  function: { name: string; description: string; parameters: any };
}> {
  return defs.map((d) => ({
    type: 'function' as const,
    function: {
      name: d.name,
      description: d.description,
      parameters: d.parameters,
    },
  }));
}

export interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * 从最近一条往前取历史，受**预算算出的**字符数与条数护栏双重限制。
 *
 * 与旧版的两点差别：
 *  ① maxChars / maxTurns 都是入参，由 allocate() 推导，本函数不含任何常数；
 *  ② 遇到装不下就 break 而不是 continue —— 必须保证取到的是**连续的最近若干轮**，
 *     否则会跳过最近那条长消息、反而塞进更老的，语义更差。
 * 当前这条用户消息通常已落库，跳过它避免模型看两遍。
 */
export function buildHistory(
  sessionId: string,
  current: string,
  maxChars: number,
  maxTurns: number
): { history: HistoryMessage[]; trimmed: boolean } {
  let rows: any[] = [];
  try {
    rows = db.getMessagesBySession(sessionId);
  } catch {
    return { history: [], trimmed: false };
  }
  const picked: HistoryMessage[] = [];
  let chars = 0;
  let trimmed = false;
  const cur = String(current || '').trim();
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r.role !== 'user' && r.role !== 'assistant') continue;
    const c = String(r.content || '').trim();
    if (!c) continue;
    // 当前这条用户消息通常已落库，跳过它，避免模型看到两遍
    if (i === rows.length - 1 && r.role === 'user' && c === cur) continue;
    if (picked.length >= maxTurns || chars + c.length > maxChars) {
      trimmed = true;
      break;
    }
    picked.unshift({ role: r.role as 'user' | 'assistant', content: c });
    chars += c.length;
  }
  return { history: picked, trimmed };
}

export interface AssembleOptions {
  owner: string;
  sessionId: string;
  /** 本轮用户原话：记忆检索的 query，也用于历史去重 */
  message: string;
  /**
   * 实际下发的本轮消息字符数（含「打开产物」兜底拼入的真实内容）。
   * 不传按 message 长度算。⚠️ 漏传会把产物内容排除在预算外，等于预算失真。
   */
  currentChars?: number;
  toolDefs: ToolDef[];
  model: string;
  /** 调度器晨报/复盘会完全替换系统提示；此时不注入记忆，预算全留给历史 */
  systemOverride?: string | null;
  /** 显式预算（探针 / 特殊场景）；不传按环境变量与模型生成 */
  budget?: TokenBudget;
}

export interface AssembledContext {
  system: string;
  memory: string;
  toolDefs: ToolDef[];
  tools: ReturnType<typeof toOpenAiTools>;
  history: HistoryMessage[];
  budget: TokenBudget;
  allocation: Allocation;
  stats: {
    systemChars: number;
    memoryChars: number;
    toolsChars: number;
    currentChars: number;
    /** 实际上带进请求的历史字符（≤ allocation.historyChars） */
    historyChars: number;
    turns: number;
    memoryCount: number;
    /** 有更早的历史因预算/条数护栏被丢下 */
    trimmed: boolean;
  };
}

/** 主循环唯一获取上下文的地方。纯装配，不发请求、不写库。 */
export function assembleContext(opts: AssembleOptions): AssembledContext {
  const budget = opts.budget ?? createBudget(opts.model);
  const message = String(opts.message || '');
  const tools = toOpenAiTools(opts.toolDefs);
  const toolsChars = JSON.stringify(tools).length;

  // systemOverride 路径下系统提示被整段替换，记忆区块没有注入点，别白查库
  const memory = opts.systemOverride ? '' : buildMemoryContext(opts.owner, message);
  const system =
    opts.systemOverride || buildSystemPrompt(memory, opts.toolDefs.map((t) => t.name));
  const currentChars = opts.currentChars ?? message.length;

  const allocation = allocate(budget, {
    systemChars: system.length,
    memoryChars: memory.length,
    toolsChars,
    currentChars,
  });
  const { history, trimmed } = buildHistory(
    opts.sessionId,
    message,
    allocation.historyChars,
    allocation.maxTurns
  );

  return {
    system,
    memory,
    toolDefs: opts.toolDefs,
    tools,
    history,
    budget,
    allocation,
    stats: {
      systemChars: system.length,
      memoryChars: memory.length,
      toolsChars,
      currentChars,
      historyChars: history.reduce((n, m) => n + m.content.length, 0),
      turns: history.length,
      memoryCount: !memory || /暂无记录/.test(memory) ? 0 : memory.split('\n').length,
      trimmed,
    },
  };
}
