/**
 * 星澜 · 主动调度器（Proactive Scheduler）
 * 让管家"不用你开口"也能办事：
 *   - 到期提醒：待办到点 → 生成 reminder_due 卡片
 *   - 每日晨报：每天一次，基于记忆/待办/心情生成当日简报
 *   - 每周复盘：每周五一次，温柔回顾本周
 * 有真实大模型凭证且开启 AGENT_BRIEFING=1 时，晨报/周复盘由真实模型生成；
 * 否则用模板生成（默认，保证可见可测）。
 */
import * as db from './db.js';
import type { ProactiveAction } from './db/proactive.js';
import { runBailianAgentTurn } from './llm/bailian.js';
import type { AgentEvent } from './agent.js';
import { isCompatEngineConfigured } from './settings.js';
import { notifyChanged } from './realtime.js';
import type { ReminderRecord } from './db.js';
import { randomUUID } from 'crypto';
import { summarizeText } from './trace.js';

/** 真实大模型是否可用（CodeBuddy SDK 分支已于 2026-10-06 移除） */
function engineConfigured(): boolean {
  return isCompatEngineConfigured();
}

function startOfTodayIso(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}
function startOfWeekIso(): string {
  const d = new Date();
  const day = d.getDay(); // 0=Sun
  const diff = (day + 6) % 7; // 距本周一
  d.setDate(d.getDate() - diff);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

// ---- 模板生成（无 SDK 时默认路径）----

/**
 * 从用户记忆里挑最适合写进晨报/复盘的（最多 2 条，保持简报不啰嗦）：
 * 优先「目标/计划」(用户当前关心) → 「偏好」(被记住的感觉) → 任一条。
 * 让主动服务真正"基于你"，而不是永远只念第一条。
 */
function pickBriefMemories(owner: string, max = 2): Array<{ key: string; value: string }> {
  const mems = db.getMemories(owner, 50);
  if (!mems.length) return [];
  const plan = mems.find((m) => m.kind === 'plan' || /目标|计划|这周|本周|想做|推进/.test(m.key + m.value));
  const pref = mems.find((m) => m.kind === 'preference' || /偏好|喜欢|习惯|讨厌|忌|作息|沟通/.test(m.key + m.value));
  const picked: Array<{ key: string; value: string }> = [];
  for (const m of [plan, pref, mems[0]]) {
    if (!m) continue;
    if (picked.some((p) => p.key === m.key && p.value === m.value)) continue; // 去重
    picked.push({ key: m.key, value: m.value });
    if (picked.length >= max) break;
  }
  return picked;
}

/**
 * F2 生活教练层：挑出用户说过的「愿望/目标」记忆（kind=plan 且语义像理想状态），
 * 供晨报/周复盘轻轻地带出来，陪他朝理想状态迈一小步。
 */
function pickGoals(owner: string, max = 1): Array<{ key: string; value: string }> {
  const mems = db.getMemories(owner, 100);
  const goals = mems.filter(
    (m) => m.kind === 'plan' && /理想状态|目标|想成为|想做|希望|愿望|立志|梦想/.test(m.key + m.value)
  );
  return goals.slice(0, max).map((m) => ({ key: m.key, value: m.value }));
}

/**
 * 晨报/周复盘的**事实层**：两条生成路径（模板 / 模型）唯一的共同数据入口。
 *
 * 为什么必须抽出来：以前模板自己查库拼句子，模型路径则只靠 buildMemoryContext
 * 拿记忆——而后者是用「写一段今日晨报」这类**生成指令**当检索 query 的，
 * 与「理想状态：想每天早起跑步」几乎零字面向合，F2 的愿望根本进不了模型。
 * 于是系统提示词承诺「你会在晨报里陪他朝它迈一小步」，模型却拿不到材料。
 *
 * 原则：**要不要说（选哪些事实）是确定性决策，怎么说（表达）才交给模型。**
 * 把前者交给相似度检索，等于让「这次提不提这个愿望」变成随机事件。
 */
export interface BriefingFacts {
  pendingCount: number;
  dueSoon: Array<{ body: string }>;
  lastMoodLevel: number | null;
  moodAvg: number | null;
  memoryCount: number;
  memories: Array<{ key: string; value: string }>;
  goals: Array<{ key: string; value: string }>;
  feedback: string | null;
}
export function collectBriefingFacts(owner: string): BriefingFacts {
  const pending = db.listReminders(owner, false);
  const dueSoon = pending
    .filter((r) => r.due_ts !== null && r.due_ts <= Date.now() + 2 * 86400000)
    .map((r) => ({ body: r.body }));
  const moods = db.recentMoods(owner, 7);
  const memoryRows = db.getMemories(owner, 50);
  return {
    pendingCount: pending.length,
    dueSoon,
    lastMoodLevel: moods.length ? moods[0].level : null,
    moodAvg: moods.length ? moods.reduce((s, m) => s + m.level, 0) / moods.length : null,
    memoryCount: memoryRows.length,
    memories: pickBriefMemories(owner),
    goals: pickGoals(owner),
    feedback: db.summarizeFeedback(owner),
  };
}

/** 解析用户的「免打扰时段」记忆（如"晚上11点后少打扰"）→ 小时窗口；无则返回 null */
export interface QuietWindow { start: number; end: number }
export function detectQuietHours(owner: string): QuietWindow | null {
  const mems = db.getMemories(owner, 50);
  for (const m of mems) {
    const text = `${m.key} ${m.value}`;
    if (!/(少打扰|不打扰|免打扰|别打扰|勿扰|安静)/.test(text)) continue;
    const hourMatch = text.match(/(\d{1,2})\s*[:：]?\s*点|(\d{1,2})\s*[:：]\s*\d{2}/);
    if (!hourMatch) continue;
    let h = parseInt(hourMatch[1] || hourMatch[2], 10);
    if (isNaN(h) || h < 0 || h > 23) continue;
    // 12 小时制换算：晚上/夜里/半夜/下午/傍晚 → +12；凌晨 12 点视为 0
    if (/晚上|夜里|夜晚|半夜|深夜|午夜|下半夜|后半夜/.test(text)) {
      if (h < 12) h += 12;
    } else if (/下午|傍晚/.test(text)) {
      if (h < 12) h += 12;
    } else if (/凌晨|清晨|拂晓/.test(text)) {
      if (h === 12) h = 0;
    }
    // "后/之后" → 从该小时覆盖到次日清晨；否则默认前后各 2 小时小窗口
    if (/后|之后|以后/.test(text)) return { start: h, end: (h + 8) % 24 };
    return { start: (h + 22) % 24, end: (h + 2) % 24 };
  }
  return null;
}

/** 当前是否处于免打扰窗口（hour 可注入以便测试） */
export function isQuietNow(qh: QuietWindow | null, hour = new Date().getHours()): boolean {
  if (!qh) return false;
  if (qh.start <= qh.end) return hour >= qh.start && hour <= qh.end;
  return hour >= qh.start || hour <= qh.end; // 跨午夜
}

// ----------------------------------------------------------------
// F3 习惯发现（routine discovery）：从真实信号驱动「何时主动」
// 替代被否的 jiwen 情绪轴方案——生活管家的主动时机来自待办/记忆/习惯的真实规律，
// 而不是浪漫关系里的思念累积。信号源：用户的周期提醒（每天/每周几）。
// ----------------------------------------------------------------

export interface RoutineMeta {
  what: string;
  freq: 'daily' | 'weekly' | 'monthly';
  at?: string; // "HH:MM"
  days?: number[]; // weekly 用，0=周日…6=周六
  dom?: number; // monthly 用，每月几号
}
const ROUTINE_THROTTLE_MS = 7 * 86_400_000; // 同一习惯每 7 天最多主动提醒一次

/** 从用户的周期提醒推导习惯候选（纯读取，无副作用） */
export function detectRoutines(owner: string): RoutineMeta[] {
  return db
    .listReminders(owner, true)
    .filter((r) => r.recur_rule && r.recur_rule.freq)
    .map((r) => ({ what: r.body, freq: r.recur_rule!.freq, at: r.recur_rule!.at, days: r.recur_rule!.days, dom: r.recur_rule!.dom }));
}

function routineSlug(rt: RoutineMeta): string {
  return `routine:${rt.what}@${rt.freq}@${rt.at || '09:00'}@${(rt.days || []).join('-')}`;
}

/** 把推导出的习惯持久化为「routine」记忆（按 slug 去重，幂等，返回新增条数） */
export function syncRoutines(owner: string): number {
  const existing = new Set(db.getMemories(owner, 200).filter((m) => m.kind === 'routine').map((m) => m.key));
  let added = 0;
  for (const rt of detectRoutines(owner)) {
    const slug = routineSlug(rt);
    if (existing.has(slug)) continue;
    db.saveMemory(owner, 'routine', slug, JSON.stringify(rt));
    existing.add(slug);
    added++;
  }
  return added;
}

/** 某习惯是否「此刻该提一句」（weekday 命中 + 时间在设定时刻 ±1 小时内）。now 可注入以便测试 */
export function routineMatchesNow(rt: RoutineMeta, now = new Date()): boolean {
  const day = now.getDay(); // 0=周日
  if (rt.freq === 'weekly') {
    if (!rt.days || !rt.days.includes(day)) return false;
  } else if (rt.freq === 'monthly') {
    if (now.getDate() !== (rt.dom ?? -1)) return false;
  }
  if (rt.at && /^(\d{1,2}):(\d{2})$/.test(rt.at)) {
    const h = parseInt(rt.at.split(':')[0], 10);
    if (Math.abs(now.getHours() - h) > 1) return false;
  }
  return true;
}

/**
 * 对当前 owner 跑一轮「习惯软提醒」：匹配此刻的习惯 → 生成一张温柔的 routine 卡片。
 * 节流：每个习惯 7 天内只推一次（用 routine_prompted:<slug> 记忆做标记）。
 * 返回本次真正推了多少张。tick() 每轮调用；无模型依赖，确定性可测。
 */
export function runRoutineCheckins(owner: string, now = new Date()): number {
  const mems = db.getMemories(owner, 200);
  const routines = mems.filter((m) => m.kind === 'routine');
  if (!routines.length) return 0;
  if (isQuietNow(detectQuietHours(owner), now.getHours())) return 0;
  let pushed = 0;
  for (const m of routines) {
    let meta: RoutineMeta | null = null;
    try {
      meta = JSON.parse(m.value);
    } catch {
      continue;
    }
    if (!meta || !routineMatchesNow(meta, now)) continue;
    const slug = m.key;
    const promptedKey = `routine_prompted:${slug}`;
    const last = mems.find((x) => x.key === promptedKey);
    if (last && Date.now() - new Date(last.updated_at).getTime() < ROUTINE_THROTTLE_MS) continue;
    const when = meta.at ? `（大约 ${meta.at}）` : '';
    db.addProactiveCard({
      owner,
      kind: 'routine',
      title: `习惯提醒：${meta.what}`,
      body: `你常在这个时候「${meta.what}」${when}。今天要照常进行吗？需要我帮你记一笔，或者顺手做点什么？`,
      ref_id: slug,
      actions: [
        { type: 'ask_agent', label: '一键问栖光', payload: { prompt: `帮我看看「${meta.what}」今天怎么安排` } },
        { type: 'open_view', label: '跳转视图', payload: { view: 'dashboard' } },
      ],
    });
    db.saveMemory(owner, 'note', promptedKey, 'prompted'); // 节流标记
    pushed++;
  }
  return pushed;
}

export function buildMorning(owner: string): { title: string; body: string } {
  const f = collectBriefingFacts(owner);
  const lines: string[] = [];
  if (f.dueSoon.length) {
    lines.push(`· 接下来有 ${f.dueSoon.length} 件事要盯：${f.dueSoon[0].body}${f.dueSoon.length > 1 ? ' 等' : ''}`);
  } else if (f.pendingCount) {
    lines.push(`· 你有 ${f.pendingCount} 件待办，暂时都不急`);
  } else {
    lines.push('· 近期没有紧迫待办，节奏可以松一点');
  }
  if (f.lastMoodLevel !== null) {
    const tone =
      f.lastMoodLevel <= 2
        ? '最近你状态有点低，今天我多陪你一会儿'
        : f.lastMoodLevel >= 4
        ? '看你最近状态不错，保持住'
        : '最近情绪平稳，挺好的';
    lines.push(`· ${tone}`);
  }
  for (const mem of f.memories) {
    lines.push(`· 按你的情况，我记着：${mem.key ? `${mem.key} → ` : ''}${mem.value}`);
  }
  // F2 生活教练层：把用户说过的愿望/目标轻轻带到晨报里，陪他朝理想状态迈一小步
  for (const g of f.goals) {
    const v = g.value.length > 30 ? g.value.slice(0, 30) + '…' : g.value;
    lines.push(`· 你说过想「${v}」——今天要不要先迈出最小的一步？`);
  }
  if (f.feedback) lines.push(`· ${f.feedback}`);
  lines.push('今天想让我帮你做点什么？规划、提醒、陪聊，都可以开口。');
  return { title: '今日晨报', body: lines.join('\n') };
}

export function buildWeekly(owner: string): { title: string; body: string } {
  const f = collectBriefingFacts(owner);
  const lines: string[] = [];
  lines.push(`· 本周还有 ${f.pendingCount} 件待办没清零`);
  if (f.moodAvg !== null) lines.push(`· 本周情绪均值 ${f.moodAvg.toFixed(1)} / 5`);
  lines.push(`· 我们已经一起攒下 ${f.memoryCount} 条关于你的记忆`);
  for (const mem of f.memories) {
    lines.push(`· 你之前提过：${mem.key ? `${mem.key} → ` : ''}${mem.value}`);
  }
  // F2 生活教练层：周复盘里也回望一下理想状态，给一句推进建议
  for (const g of f.goals) {
    const v = g.value.length > 30 ? g.value.slice(0, 30) + '…' : g.value;
    lines.push(`· 关于你提过的「${v}」——这周有没有往前挪一点点？没的话，下周咱们从最小的一步开始。`);
  }
  if (f.feedback) lines.push(`· ${f.feedback}`);
  lines.push('新的一周，想先搞定哪件事？我可以帮你把它拆开。');
  return { title: '本周复盘', body: lines.join('\n') };
}

function buildReminderCard(r: ReminderRecord): { title: string; body: string } {
  // 用结构化的 due_ts 渲染；due_at 是自由文本原文，直接 new Date() 会得到 Invalid Date
  const due =
    r.due_ts !== null
      ? new Date(r.due_ts).toLocaleString('zh-CN', {
          month: 'numeric',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        })
      : r.due_at || '未设具体时间';
  return {
    title: `提醒到了：${r.body}`,
    body: `原定 ${due}。需要我现在帮你处理，还是顺延几天？`,
  };
}

/**
 * 模型路径的 prompt：只注入**事实**，不注入模板句式。
 *
 * 这是「统一数据层 / 自由表达层」的分界线：两条路径拿到同一份 BriefingFacts，
 * 模板把它渲染成固定句式，模型则被要求用自己的话自然带出。注入固定句式等于
 * 让模型照抄模板，那模型路径就没存在价值了；反过来完全不注入，模型就只能在
 * 检索命不命中里碰运气（这正是 F2 之前被绕过的根因）。
 */
export function buildBriefingPrompt(
  owner: string,
  kind: 'morning' | 'weekly',
  f: BriefingFacts
): string {
  const facts: string[] = [];
  facts.push(`- 待办：未完成 ${f.pendingCount} 件` + (f.dueSoon.length ? `，其中近期到期 ${f.dueSoon.length} 件（如：${f.dueSoon[0].body}）` : ''));
  if (f.moodAvg !== null) facts.push(`- 近 7 天情绪均值：${f.moodAvg.toFixed(1)} / 5`);
  if (f.lastMoodLevel !== null) facts.push(`- 最近一次心情：${f.lastMoodLevel} / 5`);
  facts.push(`- 已记录记忆：${f.memoryCount} 条`);
  for (const m of f.memories) {
    facts.push(`- 记忆：${m.key ? `${m.key} → ` : ''}${m.value}`);
  }
  if (f.feedback) facts.push(`- 用户反馈：${f.feedback}`);
  if (f.goals.length) {
    facts.push(`- 用户说过的愿望/目标：${f.goals.map((g) => `「${g.value}」`).join('、')}`);
  }

  const task =
    kind === 'morning'
      ? '写一段今日晨报：亲切、简洁（3-5 句）、全程简体中文。'
      : '写一段本周复盘：温柔、有行动建议、全程简体中文、3-5 句。';
  const goalRule = f.goals.length
    ? '上面那条愿望/目标必须轻轻带到：用一个具体、今天就能做到的最小一步来提议，语气是陪伴不是说教；不要直接复述愿望原文。'
    : '本次没有记录到愿望/目标，绝不要凭空编造一个。';
  const style =
    '只能用上面的材料，不要编造未记录的安排或数据；用连贯自然的口语，不要写成「· 」开头的清单，也不要逐条复述事实。';

  return [
    `你是 AI 生活管家「星澜」。为老用户「${owner}」${task}`,
    '',
    '# 关于他的已知事实',
    ...facts,
    '',
    `# 写作要求\n${goalRule}${style}`,
  ].join('\n');
}

/**
 * 词面层（启发式）：文案里是否出现了愿望的片段。
 * 用中文 2-gram 而非整句匹配：模型本就该用自己的话，要求原文一致反而会逼它照抄。
 * ⚠️ 它只能证明「词出现了」，**不能**证明给出了推进建议，更不能证明用户被鼓励了。
 */
export function goalEchoed(body: string, goals: Array<{ value: string }>): boolean {
  if (!goals.length || !body) return false;
  const clean = goals[0].value.replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '');
  for (let i = 0; i + 2 <= clean.length; i++) {
    if (body.includes(clean.slice(i, i + 2))) return true;
  }
  return false;
}

/**
 * 提议层（启发式）：文案是否真的给了「一个具体、当下可做的最小一步」的提议。
 *
 * 为什么需要它：goalEchoed 只要命中「早起」两个字就返回 true，于是
 * 「今天天气不错，记得早起」也会被判成 F2 生效——那是提及，不是教练。
 * 这里要求**同一句里**提议语气与具体一步同时出现，双条件比单词匹配严格得多。
 * 注意它仍只是弱启发式（语气词 + 时间/量词共现），不代表真的给了可执行建议；
 * 只用于观测，不参与生成、不回灌模型上下文（红线）。
 */
const NUDGE_TONE = /要不要|要不|不如|试试|试一下|咱们|建议|可以|来个|先试试/;
const NUDGE_STEP = /一小步|最小的一步|迈出|往前挪|今天|这周|从[^，。！？]{0,10}开始|[0-9０-９]+\s*(分钟|公里|页|步|个|件)/;

/**
 * 提议层**唯一判据**：抽出「同一句里既有提议语气、又有具体一步」的那一句。
 *
 * ⚠️ 单一真相源：goalNudgePresent（是否命中）与 nudgeExcerpt（命中句原文）
 *    都必须从这里派生，绝不能各写一份正则或各自解释判据。
 *    修前的教训：主判据对**整段**分别跑 TONE/STEP，摘录却按句做双条件 →
 *    「可以」在 A 句、「今天」在 B 句就能拼出 nudge_present=true，却没有
 *    任何一句是提议。后果是两个谎言同时出现：提议率虚高，且
 *    nudge_present=true 但 excerpt='' 让多样性 covered 静默少算、分母对不上。
 *
 * 仍是弱启发式：语气词 + 时间/量词**同句共现**，不等于真的给出了可执行
 * 的最小一步；合法但换了个说法的提议也会被判 false。因此原文要摊开给
 * 人复核（见 F2Outcome.nudge_excerpt），不能把布尔值当结论。
 * 只用于只读观测，不参与生成、不回灌模型上下文（红线）。
 */
export function findNudgeSentence(body: string): string {
  if (!body) return '';
  const parts = String(body).split(/[。！？\n；;]/).map((s) => s.trim()).filter(Boolean);
  return parts.find((p) => NUDGE_TONE.test(p) && NUDGE_STEP.test(p))?.slice(0, 80) ?? '';
}

/** 提议层（启发式）。恒等价于 nudgeExcerpt(body) !== '' —— 见 findNudgeSentence */
export function goalNudgePresent(body: string): boolean {
  return findNudgeSentence(body) !== '';
}

/**
 * 抽出「提议那一句」用于表达多样性观测。
 *
 * 为什么需要它：命中率是**连续可调**的标量，模型把它压到 0.94 就能绕开
 * 任何 0.95 阈值，成本近乎为零。但「每次换一句不同的话」无法靠调数值绕过：
 * 要降低重复率，唯一办法是真的写出不一样的表达——而那正是我们想要的结果。
 * 换句话说，这个信号的**规避成本等于目标本身**（incentive-aligned）。
 *
 * 直接委托唯一判据，保证「判为命中」与「有摘录」永远是同一批样本，
 * 提议率与多样性覆盖率才用得上同一个分母。
 * 只用于只读观测，绝不回灌模型上下文（红线）。
 */
export function nudgeExcerpt(body: string): string {
  return findNudgeSentence(body);
}

/**
 * F2 决策摘要：四层证据，每层只说自己真能证明的事。
 *
 * 为什么拆层：原来的「文案落地=是」是个撒谎的布尔——它把「词面出现」
 * 包装成「用户被鼓励了」。一个生成时刻的布尔值根本承担不起这个语义。
 *   ① 材料层（确定性）：愿望有没有进生成材料 —— 事实，可断言
 *   ② 词面层（启发式）：输出有没有提到愿望
 *   ③ 提议层（启发式）：有没有给出具体最小一步
 *   ④ 行为层（事后）：用户看了/划了 —— 生成时刻恒为 pending，
 *      必须由 card_id 事后关联补上，**绝不能在生成时伪造一个结果**
 *
 * 归因边界：seen/dismissed 是**整张卡片**的反馈，划掉晨报可能是嫌待办清单
 * 啰嗦，不能解读成「F2 不受用」。这句话必须写进证据，否则新机制只是
 * 把第一个假象换成第二个更精致的假象。
 */
function describeF2(
  label: string,
  c: { body: string; viaAgent: boolean },
  goals: Array<{ value: string }>,
  cardId: string,
  kind: 'morning' | 'weekly'
): db.SpanInput {
  const head = `${label}已生成 · 路径=${c.viaAgent ? '模型' : '模板'}`;
  const mentioned = goalEchoed(c.body, goals);
  const nudge = goals.length ? goalNudgePresent(c.body) : false;
  const text = goals.length
    ? `${head} · F2候选=${goals.length}（${goals[0].value.slice(0, 20)}）` +
      ` · 材料=已注入(确定性)` +
      ` · 词面=${mentioned ? '命中' : '未命中'}(启发式)` +
      ` · 提议=${nudge ? '有' : '无'}(启发式)` +
      ` · 用户感知=不可测(见事后反馈关联)`
    : `${head} · F2=本次无愿望候选`;
  // 结构化证据：card_id 让生成时刻的 span 与事后的 proactive_feedback 可 join。
  const args_json = JSON.stringify({
    card_id: cardId,
    kind,
    path: c.viaAgent ? 'model' : 'template',
    candidates: goals.length,
    facts_injected: goals.length > 0,
    goal_mentioned: mentioned,
    nudge_present: nudge,
    // 与 nudge_present 同源（都派生自 findNudgeSentence）：命中时必有摘录，
    // 提议率与多样性覆盖率才是同一批样本、同一个分母
    nudge_excerpt: nudge ? nudgeExcerpt(c.body) : '',
    user_response: 'pending',
    caveat: '词面/提议为启发式；seen/dismissed 是整卡反馈，不能归因到 F2 单行',
  });
  return { phase: 'intent', text: summarizeText(text), args_json };
}

export type BriefingGenerator = (prompt: string) => AsyncIterable<AgentEvent>;

// 优先用 agent 生成，失败回退模板。
// viaAgent：本段内容到底是模型写的还是模板写的。没有它就没法发现
// 「走模型时 F2 的愿望根本没进 prompt」这类只在一条路径上出现的缺陷。
// generate：可注入的生成器，让探针能在不调真实 API 的前提下驱动模型路径。
export async function maybeAgent(
  owner: string,
  kind: 'morning' | 'weekly',
  fallback: () => { title: string; body: string },
  generate?: BriefingGenerator
): Promise<{ title: string; body: string; viaAgent: boolean }> {
  const base = fallback();
  if (process.env.AGENT_BRIEFING === '1' && engineConfigured()) {
    try {
      const prompt = buildBriefingPrompt(owner, kind, collectBriefingFacts(owner));
      let text = '';
      const gen = generate
        ? generate(prompt)
        : runBailianAgentTurn({
            sessionId: `sched-${owner}-${kind}-${Date.now()}`,
            message: prompt,
            customerName: owner,
            intent: 'other',
            omitTools: ['web_lookup'], // 晨报/复盘只基于库内记忆，不联网
            // 主动发起的 run：让 trace 视图能把「星澜自己开口」和「用户说话」分开
            source: 'proactive',
          });
      for await (const ev of gen) {
        if (ev.type === 'text') text += ev.content;
      }
      if (text.trim()) return { title: base.title, body: text.trim(), viaAgent: true };
    } catch {
      /* 回退模板 */
    }
  }
  return { ...base, viaAgent: false };
}

/**
 * 主动服务决策级观测：把「这一刻星澜决定做什么」落成一条可回放的 run。
 *
 * 为什么必须有它：F2（生活教练层）与 F3（习惯发现）是**纯规则驱动**的，默认
 * 根本不调用模型，所以对话引擎的 agent_spans 里压根不会出现它们——主动服务
 * 这一整半一直在观测盲区里。没有这段代码，「F2/F3 到底触发了几次」只能靠猜。
 *
 * 只在真产生了主动动作时才写库：调度器每分钟 tick 一次，若把「这次什么都没做」
 * 也记下来，trace 会被噪音淹没，真正触发的那几次反而看不见了。
 *
 * 红线（同 MEMORY.md §九）：只写库，绝不回灌模型上下文。
 */
function recordProactiveRun(owner: string, decisions: db.SpanInput[], note: string): void {
  if (!decisions.length) return;
  try {
    const runId = randomUUID();
    db.addAgentRun({
      id: runId,
      session_id: `sched-${owner}`,
      prompt: note,
      intent: 'proactive',
      model: 'scheduler',
      outcome: `${decisions.length} 个主动决策`,
      source: 'proactive',
    });
    db.addAgentSpans(runId, decisions);
  } catch {
    /* 观测失败绝不能影响主动服务本身 */
  }
}

/**
 * 需要主动服务的 owner 列表。
 * 早期直接取 `db.distinctOwners()`（sessions 里出现过的所有 customer_name），
 * 结果演示客户（何川/叶桐/周野…）各生成一张晨报，把卡片池冲爆、真正的用户反而被淹没。
 * 改为：只服务近期活跃且有实际数据（记忆/待办/会话）的 owner，并设上限。
 */
const MAX_PROACTIVE_OWNERS = 5;

function activeOwners(): string[] {
  const all = db.distinctOwners();
  const scored = all
    .map((owner) => {
      let score = 0;
      try {
        score += db.getMemories(owner, 50).length * 3;
        score += db.listReminders(owner, false).length * 2;
      } catch {
        /* 查询失败按 0 分处理 */
      }
      return { owner, score };
    })
    .filter((x) => x.score > 0) // 没有任何记忆与待办的用户不推送，避免空泛打扰
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_PROACTIVE_OWNERS);
  return scored.map((x) => x.owner);
}

/** 导出是为了让探针能真实驱动一次调度（否则 sched 的 run 只能靠等定时器，无法回归） */
export async function tick(): Promise<void> {
  const owners = activeOwners();
  const hour = new Date().getHours();
  const day = new Date().getDay(); // 5 = 周五
  for (const owner of owners) {
    // 免打扰时段：跳过晨报/周复盘等非紧急主动推送（到期提醒是用户自己设的硬截止，仍照常）
    const quiet = isQuietNow(detectQuietHours(owner));
    // 本轮主动决策收集器：非空才落一条 run（见 recordProactiveRun 注释）
    const decisions: db.SpanInput[] = [];
    // 1) 到期提醒
    for (const r of db.listDueReminders(owner)) {
      if (!db.proactiveCardExists(owner, 'reminder_due', r.id)) {
        const c = buildReminderCard(r);
        const actions: ProactiveAction[] = [
          { type: 'complete', label: '完成打卡' },
          { type: 'snooze_hour', label: '顺延1小时' },
          { type: 'snooze_day', label: '顺延1天' },
          { type: 'ask_agent', label: '一键问栖光', payload: { prompt: `帮我看看「${r.body}」现在该怎么处理` } },
          { type: 'open_view', label: '跳转视图', payload: { view: 'dashboard' } },
        ];
        db.addProactiveCard({
          owner,
          kind: 'reminder_due',
          title: c.title,
          body: c.body,
          ref_id: r.id,
          due_at: r.due_at,
          actions,
        });
        decisions.push({ phase: 'intent', text: summarizeText(`到期提醒卡片 · ${r.body}（${r.due_at || '未设时间'}）`) });
      }
    }
    // 2) 每日晨报（6 点后、当天未生成、且非免打扰时段）
    if (!quiet && hour >= 6 && !db.proactiveCardExistsSince(owner, 'morning', startOfTodayIso())) {
      const c = await maybeAgent(owner, 'morning', () => buildMorning(owner));
      const actions: ProactiveAction[] = [
        { type: 'ask_agent', label: '一键问栖光', payload: { prompt: '今天有什么要我帮忙安排的？' } },
        { type: 'open_view', label: '跳转视图', payload: { view: 'dashboard' } },
      ];
      const card = db.addProactiveCard({ owner, kind: 'morning', title: c.title, body: c.body, actions });
      // F2 四层证据：材料/词面/提议在生成时刻记，行为层留 pending 由 card_id 事后关联。
      decisions.push(describeF2('晨报', c, pickGoals(owner), card.id, 'morning'));
    }
    // 3) 每周复盘（周五 18 点后、本周未生成、且非免打扰时段）
    if (!quiet && day === 5 && hour >= 18 && !db.proactiveCardExistsSince(owner, 'weekly', startOfWeekIso())) {
      const c = await maybeAgent(owner, 'weekly', () => buildWeekly(owner));
      const actions: ProactiveAction[] = [
        { type: 'ask_agent', label: '一键问栖光', payload: { prompt: '新的一周，先帮我搞定哪件事？' } },
        { type: 'open_view', label: '跳转视图', payload: { view: 'dashboard' } },
      ];
      const card = db.addProactiveCard({ owner, kind: 'weekly', title: c.title, body: c.body, actions });
      decisions.push(describeF2('周复盘', c, pickGoals(owner), card.id, 'weekly'));
    }
    // 4) F3 习惯发现与软提醒：从周期提醒推导习惯 → 在匹配时刻温柔提一句（7 天节流，免打扰时段跳过）
    syncRoutines(owner);
    const routinePushed = runRoutineCheckins(owner);
    // F3 是纯规则、零模型调用，trace 里唯一能看到它的地方就是这条 span。
    // ⚠️ 必须只在真推送了才记：调度每分钟 tick，无条件记会让「推送 0 条」的
    //    span 每分钟刷一条，把真正触发的那几次彻底淹掉（正是 recordProactiveRun 注释里说的噪音）。
    if (routinePushed > 0) {
      decisions.push({
        phase: 'intent',
        text: summarizeText(`F3 习惯发现 · 本次推送 ${routinePushed} 条`),
      });
    }
    recordProactiveRun(
      owner,
      decisions,
      `调度 tick · owner=${owner} · hour=${hour} · quiet=${quiet ? '是' : '否'}`
    );
  }
}

// 演示态：为 guest 预置少量记忆与一条待到期提醒，让主动能力可见可测。
// 默认**关闭**（DEMO_SEED=1 才开启）：演示数据会被模型当成用户真实信息复述
// （曾出现把假待办「交水电费」、假偏好「11 点后少打扰」念给用户的情况），
// 真实使用必须保持关闭，让记忆与待办完全由用户自己产生。
function ensureDemoSeed(): void {
  if (!/^(1|true|yes)$/i.test(process.env.DEMO_SEED || '')) return;
  const owner = 'guest';
  if (db.getMemories(owner, 1).length === 0) {
    db.saveMemory(owner, 'preference', '作息', '习惯晚上 11 点后少打扰（示例）');
    db.saveMemory(owner, 'preference', '沟通', '喜欢先给结论，不喜欢被反复追问（示例）');
  }
  // 只要用户已有任何未完成的提醒就不再补演示数据，避免演示内容混进真实待办
  if (db.listReminders(owner, false).length === 0) {
    // 标题带（示例）便于一眼区分；时间给 2 小时后，避免「一启动就已过期」
    db.addReminder(owner, '交水电费（示例）', new Date(Date.now() + 2 * 3600000).toISOString());
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
export function startScheduler(intervalMs = 60000): void {
  ensureDemoSeed();
  tick().catch((e) => console.error('[Scheduler] 首次 tick 出错：', e));
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    tick().catch((e) => console.error('[Scheduler] tick 出错：', e));
  }, intervalMs);
  console.log(`[Scheduler] 主动调度已启动（间隔 ${intervalMs / 1000}s）`);
}

/** 手动触发（管理后台「立即跑一轮」用） */
export async function runSchedulerNow(): Promise<{ owners: number; ok: boolean }> {
  const owners = db.distinctOwners();
  await tick();
  notifyChanged();
  return { owners: owners.length, ok: true };
}
