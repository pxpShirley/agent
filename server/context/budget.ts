/**
 * 上下文 Token 预算分配器（P1 · 2026-11-13）
 *
 * 为什么要它：改之前上下文是**三份互不知情的截断**——
 *   · 记忆   MEMORY_CHAR_BUDGET=1800 字符（server/memory.ts 自己算）
 *   · 历史   buildHistory(maxTurns=12, maxChars=6000)（bailian.ts 里写死）
 *   · 系统提示词 / 工具 schema / 本轮消息 / 输出预留：完全没算
 * 于是「上下文受控」只是错觉：真正下发多少，取决于这四处各自的常数，
 * 换模型、加工具、加一段产物兜底内容都不能自适应。
 *
 * 设计纪律（别把它写成另一组魔法数）：
 *  ① **只有总预算是可配置量**（capTokens），其余各段用**实测字符数**扣减，
 *     剩余全给历史。不拍「system 该占 1200 token」这类脑袋数。
 *  ② 能力上限（模型窗口）与成本上限（每轮 cap）分开，取 min。
 *     上下文窗口 64K 是「塞得下」，不是「该塞满」——每轮都付费（记忆 §四）。
 *  ③ 历史的**条数**由预算推导，不再有独立的 12。字符预算才是硬约束；
 *     maxTurns 只是「消息条数护栏」，防历史里全是 1 字符的「嗯」时拼出几百条消息。
 *  ④ 换算保守：默认 1 token 只承载 1.5 个字符（中文实际常更省），宁可少给不多给。
 *
 * 纯函数、零服务端依赖：env 可注入，探针能完全离线测。
 * 红线：这里只做装配计算，输出绝不回灌成「给模型的指令」（trace 文本同理）。
 */
/** 可注入的环境变量视图：探针无需改 process.env 就能测配置分支 */
export type EnvLike = Record<string, string | undefined>;

export interface TokenBudget {
  model: string;
  /** 模型上下文窗口（能力上限） */
  windowTokens: number;
  /** 每轮主动预算（成本上限）；与 window 取 min 后生效 */
  capTokens: number;
  /** 给模型回复预留的 token */
  reserveOutputTokens: number;
  /** 保守换算：1 token 承载多少字符 */
  charsPerToken: number;
  /** 推导消息条数护栏用的「典型一轮」字符数 */
  avgTurnChars: number;
}

/** 固定段的**实测**字符数。全都是装配器真正要下发的内容，不是估算。 */
export interface ContextUsage {
  systemChars: number;
  memoryChars: number;
  toolsChars: number;
  currentChars: number;
}

export interface Allocation {
  windowTokens: number;
  capTokens: number;
  /** min(window, cap)，且有安全下限，防配置写错把预算压成负数 */
  effectiveTokens: number;
  reserveOutputTokens: number;
  charsPerToken: number;
  /** 固定段实测总字符 */
  fixedChars: number;
  /** 固定段折算 token（向上取整，保守） */
  usedTokens: number;
  historyTokens: number;
  /** 历史可占字符数：由预算算出，替代写死的 6000 */
  historyChars: number;
  /** 历史条数护栏：由预算推导，替代写死的 12 */
  maxTurns: number;
  /** 固定段已吃满预算，历史被压到 0 */
  tight: boolean;
  /** 固定段 + 输出预留已经超过总预算：配置过紧，装配器仍会工作但需告警 */
  overBudget: boolean;
}

export const CHARS_PER_TOKEN = 1.5;
export const AVG_TURN_CHARS = 500;
export const DEFAULT_CAP_TOKENS = 12_000;
export const DEFAULT_RESERVE_OUTPUT_TOKENS = 1_500;
/** 未知模型走保守窗口：宁可少给，也不要按 64K 把一轮成本打爆 */
export const UNKNOWN_MODEL_WINDOW = 8_192;
/** 生效预算的安全下限（仅防非法配置） */
export const MIN_EFFECTIVE_TOKENS = 1_024;

/** 只列项目真实会用到的供应商；命中不到的走 UNKNOWN_MODEL_WINDOW */
const MODEL_WINDOWS: Array<[RegExp, number]> = [
  [/deepseek-(chat|reasoner)/i, 65_536],
  [/qwen/i, 32_768],
];

function positive(raw: unknown, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** 按模型读窗口上限；AGENT_CONTEXT_WINDOW 可覆盖（私有化/代理/新模型） */
export function resolveWindow(model: string, env: EnvLike = process.env): number {
  const override = positive(env.AGENT_CONTEXT_WINDOW, 0);
  if (override) return Math.floor(override);
  const name = String(model || '');
  for (const [re, w] of MODEL_WINDOWS) if (re.test(name)) return w;
  return UNKNOWN_MODEL_WINDOW;
}

/** 生成本轮预算配置。所有项都有默认值，缺环境变量时行为确定。 */
export function createBudget(model: string, env: EnvLike = process.env): TokenBudget {
  return {
    model: String(model || ''),
    windowTokens: resolveWindow(model, env),
    capTokens: Math.floor(positive(env.AGENT_CONTEXT_CAP, DEFAULT_CAP_TOKENS)),
    reserveOutputTokens: Math.floor(positive(env.AGENT_RESERVE_OUTPUT, DEFAULT_RESERVE_OUTPUT_TOKENS)),
    charsPerToken: positive(env.AGENT_CHARS_PER_TOKEN, CHARS_PER_TOKEN),
    avgTurnChars: Math.floor(positive(env.AGENT_AVG_TURN_CHARS, AVG_TURN_CHARS)),
  };
}

/**
 * 预算分配：固定段实测扣减，剩余全给历史。
 * 不变量：usedTokens + historyTokens <= effectiveTokens - reserveOutputTokens（未超预算时）。
 */
export function allocate(budget: TokenBudget, usage: ContextUsage): Allocation {
  const effectiveTokens = Math.max(
    MIN_EFFECTIVE_TOKENS,
    Math.min(budget.windowTokens, budget.capTokens)
  );
  const charsPerToken = positive(budget.charsPerToken, CHARS_PER_TOKEN);
  // 逐项夹取：单个负数/NaN 不能抵消别的正数，否则预算会被「算小」而超发
  const nz = (v: number) => (Number.isFinite(v) && v > 0 ? v : 0);
  const fixedChars =
    nz(Number(usage.systemChars)) +
    nz(Number(usage.memoryChars)) +
    nz(Number(usage.toolsChars)) +
    nz(Number(usage.currentChars));
  const usedTokens = Math.ceil(fixedChars / charsPerToken);
  const reserve = Math.max(0, budget.reserveOutputTokens);
  const available = effectiveTokens - reserve - usedTokens;
  const historyTokens = Math.max(0, available);
  const historyChars = Math.floor(historyTokens * charsPerToken);
  const maxTurns = Math.max(1, Math.floor(historyChars / Math.max(1, budget.avgTurnChars)));
  return {
    windowTokens: budget.windowTokens,
    capTokens: budget.capTokens,
    effectiveTokens,
    reserveOutputTokens: reserve,
    charsPerToken,
    fixedChars,
    usedTokens,
    historyTokens,
    historyChars,
    maxTurns,
    tight: historyChars === 0,
    overBudget: usedTokens + reserve > effectiveTokens,
  };
}
