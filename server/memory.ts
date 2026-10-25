/**
 * 星澜 · 记忆检索（L2 Memory 的最小可用内核）
 *
 * 为什么要有这个文件：
 *   记忆的「打分 / 选取 / 格式化」曾经散在两处且逻辑不同——
 *     · server/agent.ts        buildMemoryContext：取最近 12 条，截断 160 字符
 *     · server/tools/registry  recall_memory：substring 过滤后取 12 条
 *   两处各写一份 = 注入给模型的记忆和工具回看的记忆**排序不一致**，
 *   这是典型的「同一份数据两个真相源」，迟早漂移。此处收敛为唯一实现。
 *
 * 核心设计（回答「预注入记忆该注入多少」）：
 *   **注入量 = min(相关性截断后的条数, 字符预算允许的条数)**
 *   - 从前是「固定 12 条」——条数是常数，与这轮问什么无关，也与每条多长无关。
 *     结果是长记忆挤掉短记忆、陈旧的高频记忆挤掉刚记住的。
 *   - 现在按得分降序**贪心累加到字符预算用完为止**：预算是硬上限，条数是结果而非前提。
 *   - 预算本身是**可推导、可覆盖**的（见 DEFAULT_MEMORY_BUDGET 的推导注释），
 *     不是拍脑袋常数——换更大窗口的模型时按比例伸缩即可。
 *
 * 打分三要素（权重合为 1）：
 *   相关性 0.6 —— 本轮用户消息与记忆的关键词命中（key 命中额外加权）
 *   新鲜度 0.3 —— 30 天半衰的时间衰减，刚记住的更值钱
 *   类型   0.1 —— preference/fact（身份与偏好）> plan > note
 */

import type { MemoryRecord } from './db/memories.js';

export interface MemoryBudget {
  /** 注入上下文的记忆区块字符总预算（硬上限） */
  charBudget: number;
  /** 条数硬上限：即使预算还有富余也不再多加（防单条过短时塞进几十条噪音） */
  maxItems: number;
  /** 单条记忆截断长度：防长 blob 吃满预算 */
  snippetMax: number;
}

/**
 * 默认预算的推导（deepseek-chat / qwen-plus 一类 64K 窗口模型）：
 *   系统提示词固定部分        ≈ 2 600 字符
 *   工具 schema（约 13 个）   ≈ 4 000 token
 *   多轮历史 buildHistory     ≤ 6 000 字符
 *   本轮输出                  ≤ 1 500 token
 *   以上合计远小于 64K，真正的风险不是撑爆窗口，而是**每轮都付费**——
 *   记忆区块每多 1000 字符，每一轮对话都要多付这 1000 字符的输入成本。
 * 所以取「够让模型认出这个人」的最小充分值：约 12 条 × 150 字符 ≈ 1 800 字符。
 * 可用 MEMORY_CHAR_BUDGET 环境变量覆盖（换模型 / 调优时无需改代码）。
 */
export const DEFAULT_MEMORY_BUDGET: MemoryBudget = {
  charBudget: Number(process.env.MEMORY_CHAR_BUDGET || 1800),
  maxItems: Number(process.env.MEMORY_MAX_ITEMS || 12),
  snippetMax: Number(process.env.MEMORY_SNIPPET_MAX || 160),
};

/**
 * 类型权重：身份与偏好最值钱，随手记的 note 最不值钱。
 *
 * P1（2026-10-24）扩展词表——借 Hindsight 的 4 桶记忆分类（World/Experiences/
 * Observations/Mental models），把"只会存事实"升级为"会存经历与对用户的抽象理解"：
 *   - experience 经历：某次对话发生了什么、结论是什么（episodic，补上原缺口）
 *   - observation 观察：模型从交互观察到的（情绪/状态推断）
 *   - mental      心智模型：对用户的抽象理解（"夜猫子""决策前需要选项"）
 * 旧 kind（preference/fact/plan/note）权重不变，向后兼容。
 */
export const KIND_WEIGHT: Record<string, number> = {
  mental: 0.95, // 对用户的抽象理解，最值钱
  preference: 1.0,
  observation: 0.85,
  fact: 0.9,
  plan: 0.6,
  experience: 0.7, // 经历：近期权重靠 episodic 弱召回补足
  note: 0.4,
};

/** kind → 中文分组标签（导出视图用） */
export const KIND_LABEL: Record<string, string> = {
  mental: '心智模型',
  preference: '偏好',
  observation: '观察',
  fact: '事实',
  plan: '计划',
  experience: '经历',
  note: '随手记',
};

/**
 * 高频但无区分度的 2-gram。中文没有空格，只能靠 2-gram 分词，
 * 若不滤掉这些，「帮我设置一个提醒」会和「提醒我喝水」产生假命中。
 */
const STOP_GRAMS = new Set([
  '一个', '这个', '那个', '什么', '怎么', '可以', '帮我', '我想', '我要', '一下',
  '现在', '今天', '知道', '需要', '还是', '就是', '不是', '有没有', '的话', '这样',
]);

/**
 * 分词：英文数字按词，中文按 2-gram（中文无空格，2-gram 是性价比最高的近似）。
 * 单字词也保留，否则「糖」「茶」这类偏好词会被漏掉。
 */
export function tokenize(query: string): string[] {
  const q = String(query || '').toLowerCase();
  const ascii = (q.match(/[a-z0-9]{2,}/g) || []);
  const han = q.replace(/[^一-龥]/g, '');
  const grams: string[] = [];
  if (han.length === 1) {
    grams.push(han);
  } else {
    for (let i = 0; i + 2 <= han.length; i++) grams.push(han.slice(i, i + 2));
  }
  return Array.from(new Set([...ascii, ...grams])).filter((t) => !STOP_GRAMS.has(t));
}

/** 新鲜度：30 天半衰。今天记的 ≈1.0，30 天前 ≈0.5，半年以上 ≈0.14 */
function freshness(updatedAt: string, nowMs: number): number {
  const t = Date.parse(updatedAt || '');
  if (!Number.isFinite(t)) return 0.3;
  const ageDays = Math.max(0, (nowMs - t) / 86_400_000);
  return 1 / (1 + ageDays / 30);
}

/** 单条记忆与本轮 query 的相关性得分（0~1） */
export function relevanceOf(r: MemoryRecord, tokens: string[]): number {
  if (!tokens.length) return 0;
  const key = String(r.key || '').toLowerCase();
  const hay = `${key} ${String(r.value || '')} ${String(r.kind || '')}`.toLowerCase();
  let hit = 0;
  for (const t of tokens) if (hay.includes(t)) hit++;
  if (hit === 0) return 0;
  // 命中即给基础分 0.5；多命中线性加分至饱和 0.9；key（记忆的「标题」）命中再 +0.1
  const extra = Math.min(0.4, (hit - 1) * 0.15);
  const keyBonus = tokens.some((t) => key.includes(t)) ? 0.1 : 0;
  return Math.min(1, 0.5 + extra + keyBonus);
}

/** 综合得分：相关性 0.6 + 新鲜度 0.3 + 类型 0.1 */
export function scoreMemory(
  r: MemoryRecord,
  tokens: string[],
  nowMs = Date.now(),
  opts: { episodicBoost?: boolean } = {}
): number {
  const kind = KIND_WEIGHT[String(r.kind || '')] ?? 0.5;
  let s = relevanceOf(r, tokens) * 0.6 + freshness(r.updated_at, nowMs) * 0.3 + kind * 0.1;
  // P1 episodic 弱召回：模糊 query（关键词少）时，给近期 experience 额外加权，
  // 让管家能说「上次我们聊过 X」。明确关键词时本开关关闭，不破坏相关性优先。
  if (opts.episodicBoost && r.kind === 'experience') {
    s += freshness(r.updated_at, nowMs) * 0.12;
  }
  return s;
}

/** 单条记忆格式化为上下文一行（过长截断） */
export function formatMemoryLine(r: MemoryRecord, snippetMax = DEFAULT_MEMORY_BUDGET.snippetMax): string {
  const v = String(r.value || '').replace(/\s+/g, ' ').trim();
  const text = v.length > snippetMax ? v.slice(0, snippetMax) + '…' : v;
  return `· [${r.kind}] ${r.key}：${text}`;
}

/**
 * P1（2026-10-24）记忆可检视导出：按 kind 分组渲染为 Markdown。
 * 对应 OpenClaw 的「记忆是纯文件、人能直接读」教训——星澜记忆活在 sqlite，
 * 导出视图让人/调试能一眼看清楚管家到底记住了关于用户的什么。
 * 纯函数、不落库、可单测。前端/运营后台可拿去渲染或下载。
 */
export function exportMemoryMarkdown(rows: MemoryRecord[]): string {
  const groups: Record<string, MemoryRecord[]> = {};
  for (const r of rows) {
    (groups[r.kind] ||= []).push(r);
  }
  const order = ['mental', 'preference', 'observation', 'fact', 'plan', 'experience', 'note'];
  const lines: string[] = ['# 星澜记忆导出', ''];
  for (const kind of order) {
    const items = groups[kind];
    if (!items?.length) continue;
    lines.push(`## ${KIND_LABEL[kind] || kind}（${items.length}）`);
    for (const r of items.slice().sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))) {
      const v = String(r.value || '').replace(/\s+/g, ' ').trim();
      lines.push(`- **${r.key}**：${v}`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd() + '\n';
}

/**
 * 选取要注入上下文 / 回看给模型的记忆。
 * @param rows   候选池（调用方按自己的上限取，通常 60 条）
 * @param query  本轮用户原话；为空时退化为「新鲜度 + 类型」排序
 * @param budget 预算；不传用默认
 */
export function selectMemories(
  rows: MemoryRecord[],
  query = '',
  budget: Partial<MemoryBudget> = {}
): MemoryRecord[] {
  const b: MemoryBudget = { ...DEFAULT_MEMORY_BUDGET, ...budget };
  const tokens = tokenize(query);
  const nowMs = Date.now();
  // 模糊 query（无 / 极少关键词）→ 开启 episodic 弱召回
  const vague = tokens.length === 0 || tokens.length <= 1;
  const scored = rows
    .map((r) => ({ r, s: scoreMemory(r, tokens, nowMs, { episodicBoost: vague }) }))
    .sort((a, b2) => b2.s - a.s);

  const picked: MemoryRecord[] = [];
  let used = 0;
  for (const { r } of scored) {
    if (picked.length >= b.maxItems) break;
    const len = formatMemoryLine(r, b.snippetMax).length;
    if (used + len > b.charBudget) break; // 预算是硬约束：低分的不该插队
    picked.push(r);
    used += len;
  }
  return picked;
}
