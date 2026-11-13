import { v4 as uuidv4 } from 'uuid';
import { db, now } from './core.js';
import * as rem from './reminders.js';

/** 主动卡可内联触发的动作类型（A4） */
export type ProactiveActionType =
  | 'complete' // 服务端：完成/打卡（需 ref_id 指向待办）
  | 'snooze_hour' // 服务端：顺延 1 小时（需 ref_id）
  | 'snooze_day' // 服务端：顺延 1 天（需 ref_id）
  | 'ask_agent' // 客户端：把预设问题丢给栖光对话（不碰后端）
  | 'open_view'; // 客户端：跳转到某个视图（不碰后端）

/** 单条内联动作：type 决定执行方与落地逻辑，label 是展示文案，payload 携带执行参数 */
export interface ProactiveAction {
  type: ProactiveActionType;
  label: string;
  /** ask_agent → { prompt }；open_view → { view }；其余可空 */
  payload?: { prompt?: string; view?: 'home' | 'dashboard' | 'governance' };
}

export interface ProactiveCard {
  id: string;
  owner: string;
  kind: string;
  title: string;
  body: string;
  status: string; // pending | seen | dismissed
  ref_id: string | null;
  due_at: string | null;
  created_at: string;
  /** 内联动作清单（A4）；空数组表示无可点动作，仅能已读/忽略 */
  actions: ProactiveAction[];
}

const VALID_ACTION_TYPES: ProactiveActionType[] = ['complete', 'snooze_hour', 'snooze_day', 'ask_agent', 'open_view'];

/**
 * 容错解析 actions（JSON 文本 → 结构化动作）。
 * 列缺失 / 非法 JSON / 非数组 / 字段残缺 都降级为 []，绝不抛错（与 parseSteps 同策略）。
 */
export function parseActions(raw: unknown): ProactiveAction[] {
  if (!raw) return [];
  let arr: unknown;
  try {
    arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: ProactiveAction[] = [];
  for (const it of arr) {
    if (!it || typeof it !== 'object') continue;
    const o = it as Record<string, unknown>;
    const type = o.type as ProactiveActionType;
    const label = typeof o.label === 'string' ? o.label : '';
    if (!label || !VALID_ACTION_TYPES.includes(type)) continue;
    const payload =
      o.payload && typeof o.payload === 'object' ? (o.payload as ProactiveAction['payload']) : undefined;
    out.push({ type, label, payload });
  }
  return out;
}

function rowToCard(row: Record<string, any>): ProactiveCard {
  return {
    id: String(row.id),
    owner: String(row.owner),
    kind: String(row.kind),
    title: String(row.title ?? ''),
    body: String(row.body ?? ''),
    status: String(row.status ?? 'pending'),
    ref_id: row.ref_id ?? null,
    due_at: row.due_at ?? null,
    created_at: String(row.created_at ?? ''),
    actions: parseActions(row.actions),
  };
}

export function addProactiveCard(card: {
  owner: string;
  kind: string;
  title: string;
  body?: string;
  ref_id?: string | null;
  due_at?: string | null;
  actions?: ProactiveAction[];
}): ProactiveCard {
  const row: ProactiveCard = {
    id: uuidv4(),
    owner: card.owner,
    kind: card.kind,
    title: card.title,
    body: card.body ?? '',
    status: 'pending',
    ref_id: card.ref_id ?? null,
    due_at: card.due_at ?? null,
    created_at: now(),
    actions: card.actions ?? [],
  };
  db.prepare(
    `INSERT INTO proactive_cards (id,owner,kind,title,body,status,ref_id,due_at,created_at,actions)
     VALUES (@id,@owner,@kind,@title,@body,@status,@ref_id,@due_at,@created_at,@actions)`
  ).run({ ...row, actions: JSON.stringify(row.actions) });
  return row;
}

/** 某 owner 的主动卡片（默认排除已忽略 dismissed） */
export function getProactive(owner: string, includeDismissed = false): ProactiveCard[] {
  const sql = includeDismissed
    ? 'SELECT * FROM proactive_cards WHERE owner = ? ORDER BY created_at DESC'
    : "SELECT * FROM proactive_cards WHERE owner = ? AND status != 'dismissed' ORDER BY created_at DESC";
  return (db.prepare(sql).all(owner) as Array<Record<string, any>>).map(rowToCard);
}

/** 运营侧全量主动卡片 */
export function listAllProactive(limit = 200): ProactiveCard[] {
  return (db.prepare('SELECT * FROM proactive_cards ORDER BY created_at DESC LIMIT ?').all(limit) as Array<Record<string, any>>).map(
    rowToCard,
  );
}

export function markProactiveSeen(id: string): boolean {
  return db.prepare("UPDATE proactive_cards SET status = 'seen' WHERE id = ?").run(id).changes > 0;
}

export function dismissProactive(id: string): boolean {
  return db.prepare("UPDATE proactive_cards SET status = 'dismissed' WHERE id = ?").run(id).changes > 0;
}

/** 防重：指定 kind 是否已有未忽略卡片（reminder_due 用 ref_id 去重，其余通用） */
export function proactiveCardExists(owner: string, kind: string, refId?: string | null): boolean {
  const sql = refId
    ? "SELECT 1 FROM proactive_cards WHERE owner = ? AND kind = ? AND ref_id = ? AND status != 'dismissed' LIMIT 1"
    : "SELECT 1 FROM proactive_cards WHERE owner = ? AND kind = ? AND status != 'dismissed' LIMIT 1";
  const row = refId ? db.prepare(sql).get(owner, kind, refId) : db.prepare(sql).get(owner, kind);
  return !!row;
}

/** 防重（按时间窗）：指定 kind 自 since 起是否已有未忽略卡片（晨报/周复盘每日/每周唯一） */
export function proactiveCardExistsSince(owner: string, kind: string, sinceIso: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM proactive_cards WHERE owner = ? AND kind = ? AND created_at >= ? AND status != 'dismissed' LIMIT 1")
    .get(owner, kind, sinceIso);
  return !!row;
}

export function getProactiveCardById(id: string): ProactiveCard | undefined {
  const row = db.prepare('SELECT * FROM proactive_cards WHERE id = ?').get(id) as Record<string, any> | undefined;
  return row ? rowToCard(row) : undefined;
}

/** 顺延毫秒常量（与服务端动作一一对应） */
const SNOOZE_MS: Record<'snooze_hour' | 'snooze_day', number> = {
  snooze_hour: 3600_000,
  snooze_day: 86_400_000,
};

/**
 * 执行一张主动卡的某个内联动作（A4 服务端分支）。
 * - 服务端动作（complete / snooze_*）：按卡片 ref_id 操作对应待办（带 owner 校验）；
 *   成功后记一条 seen 反馈信号（越用越懂你）并把卡片收起（dismissed），避免重复浮起。
 * - 客户端动作（ask_agent / open_view）：不碰后端，返回 clientOnly 让前端自行处理
 *   （仍记一条 seen 信号并标 seen，保证刷新后不重复浮卡）。
 * - owner 不匹配 / 卡片不存在 / 已 dismissed / 非法 type → 返回 error，不改变任何数据。
 */
export function executeProactiveAction(
  owner: string,
  cardId: string,
  type: ProactiveActionType,
): { ok: boolean; clientOnly?: boolean; error?: string } {
  if (!VALID_ACTION_TYPES.includes(type)) return { ok: false, error: 'invalid-type' };
  const card = getProactiveCardById(cardId);
  if (!card) return { ok: false, error: 'card-not-found' };
  if (card.owner !== owner) return { ok: false, error: 'forbidden' };
  if (card.status === 'dismissed') return { ok: false, error: 'dismissed' };

  if (type === 'ask_agent' || type === 'open_view') {
    recordProactiveFeedback(owner, card.id, card.kind, 'seen');
    markProactiveSeen(card.id);
    return { ok: true, clientOnly: true };
  }

  // 服务端动作必须有 ref_id 指向一条待办
  if (!card.ref_id) return { ok: false, error: 'no-ref' };
  if (type === 'complete') {
    if (!rem.completeReminder(card.ref_id)) return { ok: false, error: 'reminder-not-found' };
  } else {
    const delta = SNOOZE_MS[type];
    if (!rem.snoozeReminder(card.ref_id, delta)) return { ok: false, error: 'reminder-not-found' };
  }
  recordProactiveFeedback(owner, card.id, card.kind, 'seen');
  dismissProactive(card.id);
  return { ok: true };
}

// ---- 主动卡反馈学习 ----
export type FeedbackAction = 'seen' | 'dismissed';
export interface FeedbackCounts {
  seen: number;
  dismissed: number;
}

/** 记录一条反馈信号（seen=有空看一眼 / dismissed=划掉不感兴趣） */
export function recordProactiveFeedback(
  owner: string,
  cardId: string | null,
  kind: string,
  action: FeedbackAction
): void {
  db.prepare(
    `INSERT INTO proactive_feedback (id, owner, card_id, kind, action, created_at)
     VALUES (@id, @owner, @card_id, @kind, @action, @created_at)`
  ).run({ id: uuidv4(), owner, card_id: cardId ?? null, kind, action, created_at: now() });
}

/** 某 owner 各 kind 的 seen/dismissed 计数 */
export function getProactiveFeedback(owner: string): Record<string, FeedbackCounts> {
  const rows = db
    .prepare('SELECT kind, action, COUNT(*) AS c FROM proactive_feedback WHERE owner = ? GROUP BY kind, action')
    .all(owner) as Array<{ kind: string; action: string; c: number }>;
  const out: Record<string, FeedbackCounts> = {};
  for (const r of rows) {
    out[r.kind] = out[r.kind] || { seen: 0, dismissed: 0 };
    if (r.action === 'seen') out[r.kind].seen = r.c;
    else if (r.action === 'dismissed') out[r.kind].dismissed = r.c;
  }
  return out;
}

/** 清空某 owner 的主动卡反馈信号（治理/重置用） */
export function clearProactiveFeedback(owner: string): number {
  return db.prepare('DELETE FROM proactive_feedback WHERE owner = ?').run(owner).changes;
}

/**
 * F2 事后结果关联（只读观测）：把「生成时刻的四层证据」与「之后用户的行为」
 * 按 card_id 拼到一行。
 *
 * 设计约束（想清楚再改）：
 * ① 生成时刻的 span 里 user_response 恒为 'pending' —— 用户还没看到卡片，
 *    不能在生成时写一个不存在的结果。行为只能事后 join。
 * ② 没有反馈记录返回 'none'（「暂无信号」），**不是** 'dismissed' 也不是 false。
 *    没点 ≠ 不喜欢，把缺失当负面会直接把统计带偏。
 * ③ 反馈粒度是**整张卡片**（morning/weekly），不是 F2 那一行。划掉晨报可能
 *    只是嫌待办清单啰嗦；因此这里的 response 只能读作「这张卡后来怎样」，
 *    绝不能解读成「F2 受用/不受用」。
 * ④ 只读，绝不回灌模型上下文（Trace 红线）。
 */
export interface F2Outcome {
  card_id: string;
  owner: string;
  kind: 'morning' | 'weekly';
  created_at: string;
  body_excerpt: string;
  response: 'seen' | 'dismissed' | 'none';
  responded_at: string | null;
  goal_mentioned: boolean | null;
  nudge_present: boolean | null;
  /**
   * 判为提议的那一句原文，摊开给观测者人工复核。
   * ⚠️ 判据只是弱启发式（语气词 + 时间/量词同句共现），不等于真的给出
   * 了可执行一步；布尔值会撒谎，原文不会。null = 旧版 span 无此字段或无摘录。
   */
  nudge_excerpt: string | null;
  path: 'model' | 'template' | null;
}
export function getF2Outcomes(owner?: string, limit = 50): F2Outcome[] {
  const rows = db
    .prepare(
      `SELECT c.id AS card_id, c.owner, c.kind, c.created_at, c.body AS card_body,
              f.action AS response, f.created_at AS responded_at
       FROM proactive_cards c
       LEFT JOIN proactive_feedback f ON f.card_id = c.id
       WHERE c.kind IN ('morning','weekly') ${owner ? 'AND c.owner = ?' : ''}
       ORDER BY c.created_at DESC, f.created_at DESC`
    )
    .all(...(owner ? [owner] : [])) as Array<Record<string, any>>;

  // 生成时刻的结构化证据存在 span.args_json 里（JSON 文本，用 JS 解析避免依赖 JSON1 扩展）
  const spanRows = db
    .prepare(`SELECT args_json FROM agent_spans WHERE phase = 'intent' AND args_json LIKE '%"card_id"%'`)
    .all() as Array<{ args_json: string }>;
  const evidence = new Map<string, {
    goal_mentioned: boolean; nudge_present: boolean; path: string; nudge_excerpt: string;
  }>();
  for (const r of spanRows) {
    try {
      const j = JSON.parse(r.args_json);
      if (j?.card_id) evidence.set(j.card_id, {
        goal_mentioned: Boolean(j.goal_mentioned),
        nudge_present: Boolean(j.nudge_present),
        path: String(j.path || ''),
        nudge_excerpt: typeof j.nudge_excerpt === 'string' ? j.nudge_excerpt : '',
      });
    } catch {
      /* 旧 span / 脏数据忽略 */
    }
  }

  const seen = new Set<string>();
  const out: F2Outcome[] = [];
  for (const r of rows) {
    if (seen.has(r.card_id)) continue; // 同一卡片多次反馈只取最新一条
    seen.add(r.card_id);
    const ev = evidence.get(r.card_id);
    const action = r.response === 'seen' || r.response === 'dismissed' ? r.response : 'none';
    out.push({
      card_id: r.card_id,
      owner: r.owner,
      kind: r.kind,
      created_at: r.created_at,
      body_excerpt: String(r.card_body || '').slice(0, 80),
      response: action,
      responded_at: action === 'none' ? null : r.responded_at,
      goal_mentioned: ev ? ev.goal_mentioned : null,
      nudge_present: ev ? ev.nudge_present : null,
      // 旧版 span 没有摘录字段：返回 null（「没记录」），不要拿空串冒充「判为无提议」
      nudge_excerpt: ev ? (ev.nudge_excerpt || null) : null,
      path: ev && (ev.path === 'model' || ev.path === 'template') ? ev.path : null,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** 指标饱和判定的最小样本量：少于它只是噪声，不配叫「恒真」 */
const SATURATION_MIN = 5;
/** ⚠️ 弱信号阈值：命中率是连续标量，压到 0.94 即可绕开，规避成本近乎为零 */
const SATURATION_RATE = 0.95;

/**
 * 表达多样性：只描述**分布**，刻意不给「是否塌缩」的布尔结论。
 *
 * 为什么它是更强的证据：命中率是连续可调的标量，模型把它压到 0.94
 * 就能绕开任何 0.95 阈值，成本几乎为零；但要降低重复率，唯一办法是
 * 真的写出不一样的表达——而这正是我们想要的结果。
 * 于是「刷指标」与「做好产品」变成同一件事（规避成本 = 目标本身）。
 * 这也意味着它不需要阈值：唯一率 0.2 和 1.0 之间的差别本身就是信息。
 */
export interface DiversityStat {
  /** 有提议句摘录的样本数（旧版 span 没有该字段，不计入） */
  covered: number;
  distinct: number;
  uniqueRate: number | null;
  /** 最高频那句占全部摘录的比例：1 = 所有卡片都在说同一句 */
  topRepeatShare: number | null;
  topExcerpt: string | null;
}
export function summarizeDiversity(excerpts: string[]): DiversityStat {
  const vals = excerpts.map((e) => String(e || '').trim()).filter(Boolean);
  if (!vals.length) {
    return { covered: 0, distinct: 0, uniqueRate: null, topRepeatShare: null, topExcerpt: null };
  }
  const counts = new Map<string, number>();
  for (const v of vals) counts.set(v, (counts.get(v) || 0) + 1);
  let top = '';
  let topN = 0;
  for (const [k, n] of counts) {
    if (n > topN) { top = k; topN = n; }
  }
  return {
    covered: vals.length,
    distinct: counts.size,
    uniqueRate: counts.size / vals.length,
    topRepeatShare: topN / vals.length,
    topExcerpt: top.slice(0, 80),
  };
}

export interface F2PathStats {
  path: 'model' | 'template';
  /** 全部样本（行为层分布的分母） */
  samples: number;
  /** 有愿望候选的样本：只有这些才「理应」给出提议，是词面率/提议率的分母 */
  eligible: number;
  /** 无愿望候选的样本：计入 samples，但不进率的分母 */
  noCandidate: number;
  mentionedRate: number | null;
  nudgeRate: number | null;
  /** ⚠️ 弱信号：命中率恒高。可被「压到 0.94」零成本规避，单独不构成结论 */
  saturated: boolean;
  /** 模板路径固定句式，恒真是设计使然，不该当警报 */
  expectedSaturation: boolean;
  /** 表达多样性：规避它就得真的写不同的话，因而是更难刷的独立证据 */
  diversity: DiversityStat;
  /**
   * 「判为提议却没有摘录」的样本数：新版 span 里两者同源，应恒为 0；
   * 非 0 只可能是旧版 span（当时还没记摘录）。显式暴露它，是为了让
   * 提议率与多样性 covered 的分母差**可见**，而不是静默少算。
   */
  excerptMissing: number;
  seen: number;
  dismissed: number;
  noSignal: number;
  /** 分母是全部样本，不是「有反馈的样本」——否则会选择性偏差 */
  noSignalRate: number | null;
}
export interface F2Stats {
  days: number;
  since: string;
  total: number;
  staleSpansSkipped: number;
  byPath: F2PathStats[];
  divergence: 'none' | 'suspicious' | 'insufficient';
  note: string;
}

/**
 * F2 分布健康度（只读，退化检测，不是效果证明）。
 *
 * 认识论前提：所有生成侧的文本指标（词面、提议句式）模型都能稳定复现，
 * 因此**逐条布尔值没有意义，只有分布和变化有意义**。指标一旦恒真，
 * 恰恰说明它已被优化到失去信息量（古德哈特定律）。
 *
 * 刻意的设计：
 * ① **不返回单一「有效率」** —— 再造一个分数，就是再造一个会被当成
 *    目标去刷的指标。
 * ② **按 path 分组** —— 模板路径恒真是写死的句式，把它和模型路径混算
 *    会稀释掉模型路径的异常，这是最容易踩的统计陷阱。
 * ③ 无信号率以**全部样本**为分母，不只看有反馈的那些。
 * ④ 用户侧行为由系统外产生、生成侧无法直接控制；当「生成侧饱和」
 *    与「用户侧走低」同时出现，这个**背离**才是刷不动的信号。
 * ⑤ **阈值由规避成本决定，不由数值决定**：0.95 能被 0.94 零成本绕开，
 *    所以 saturated 只是弱信号。表达多样性（唯一率/最高频占比）无法靠
 *    调数值规避——要降低重复率就得真的写不同的话，那正是我们要的结果。
 *    因此多样性只给连续分布、不给布尔阈值，也不单独下结论。
 *    **任一信号都不构成结论，组合与变化才值得看。**
 *
 * 红线：只读聚合，绝不回灌模型上下文。
 */
export function getF2Stats(days = 30): F2Stats {
  const windowDays = Math.min(365, Math.max(1, Math.trunc(days) || 30));
  const since = new Date(Date.now() - windowDays * 86_400_000).toISOString();
  const spans = db
    .prepare(
      `SELECT args_json FROM agent_spans
       WHERE phase = 'intent' AND args_json LIKE '%"card_id"%' AND created_at >= ?`
    )
    .all(since) as Array<{ args_json: string }>;

  // 用户侧行为：每卡取最新一条
  const feedback = db
    .prepare('SELECT card_id, action FROM proactive_feedback WHERE card_id IS NOT NULL ORDER BY created_at DESC')
    .all() as Array<{ card_id: string; action: string }>;
  const responseByCard = new Map<string, 'seen' | 'dismissed'>();
  for (const f of feedback) {
    if (responseByCard.has(f.card_id)) continue;
    if (f.action === 'seen' || f.action === 'dismissed') responseByCard.set(f.card_id, f.action);
  }

  let staleSpansSkipped = 0;
  const groups = new Map<'model' | 'template', {
    samples: number; eligible: number; mentioned: number; nudge: number;
    seen: number; dismissed: number; noSignal: number; excerpts: string[]; excerptMissing: number;
  }>();
  for (const s of spans) {
    let j: any;
    try { j = JSON.parse(s.args_json); } catch { staleSpansSkipped++; continue; }
    // 旧版本 / 脏数据没有分层字段：跳过而不是当成 false，否则会把历史全算成「未命中」
    if (!j?.card_id || typeof j.goal_mentioned !== 'boolean' || typeof j.nudge_present !== 'boolean') {
      staleSpansSkipped++;
      continue;
    }
    const path: 'model' | 'template' = j.path === 'model' ? 'model' : 'template';
    const g = groups.get(path) || {
      samples: 0, eligible: 0, mentioned: 0, nudge: 0, seen: 0, dismissed: 0,
      noSignal: 0, excerpts: [], excerptMissing: 0,
    };
    g.samples++;
    // 无愿望候选 → 不进率的分母：把它算成「提议失败」会把分母稀释成失真
    if (j.facts_injected === true) {
      g.eligible++;
      if (j.goal_mentioned) g.mentioned++;
      if (j.nudge_present) {
        g.nudge++;
        // 旧版 span 没有摘录字段：不计入 covered，但显式记一笔，别把「没记录」当成「重复」
        if (typeof j.nudge_excerpt === 'string' && j.nudge_excerpt.trim()) g.excerpts.push(j.nudge_excerpt);
        else g.excerptMissing++;
      }
    }
    const r = responseByCard.get(j.card_id);
    if (r === 'seen') g.seen++;
    else if (r === 'dismissed') g.dismissed++;
    else g.noSignal++;
    groups.set(path, g);
  }

  const paths: Array<'model' | 'template'> = ['model', 'template'];
  const byPath: F2PathStats[] = paths.filter((p) => groups.has(p)).map((p) => {
    const g = groups.get(p)!;
    const mentionedRate = g.eligible ? g.mentioned / g.eligible : null;
    const nudgeRate = g.eligible ? g.nudge / g.eligible : null;
    const saturated = g.eligible >= SATURATION_MIN && nudgeRate !== null && nudgeRate >= SATURATION_RATE && p === 'model';
    const expectedSaturation = p === 'template' && g.eligible >= SATURATION_MIN && nudgeRate !== null && nudgeRate >= SATURATION_RATE;
    return {
      path: p,
      samples: g.samples,
      eligible: g.eligible,
      noCandidate: g.samples - g.eligible,
      mentionedRate,
      nudgeRate,
      saturated,
      expectedSaturation,
      diversity: summarizeDiversity(g.excerpts),
      excerptMissing: g.excerptMissing,
      seen: g.seen,
      dismissed: g.dismissed,
      noSignal: g.noSignal,
      noSignalRate: g.samples ? g.noSignal / g.samples : null,
    };
  });

  const model = byPath.find((x) => x.path === 'model');
  let divergence: F2Stats['divergence'] = 'none';
  if (!model || model.eligible < SATURATION_MIN) divergence = 'insufficient';
  else if (model.saturated && model.dismissed > model.seen && model.dismissed > 0) divergence = 'suspicious';

  const total = byPath.reduce((n, x) => n + x.samples, 0);
  const note = [
    '逐条布尔没有意义，只有分布和变化有意义：生成侧指标可被模型稳定复现，恒真不是变好，而是指标已被刷到失去分辨力（古德哈特定律）。',
    '模板路径恒真属设计使然，只有模型路径的饱和值得警惕；两者必须分开统计。',
    '词面率/提议率的分母只含「有愿望候选」的样本：没有愿望可提的卡片不该被算成提议失败。行为层分布与无信号率仍以全部样本为分母。',
    'seen/dismissed 是整张卡片的反馈，不能归因到 F2 那一行；none 是暂无信号（不等于负面），无信号率以全部样本为分母。',
    '阈值由规避成本决定而非数值：0.95 可被 0.94 零成本绕开，所以命中率饱和只是弱信号。表达多样性无法靠调数值规避——要降低重复率就得真的写不同的话，那正是我们要的结果；故多样性只给连续分布、不给布尔阈值。',
    '摘录里内嵌了用户愿望原文，模板路径会因此天然显得「多样」，所以多样性同样必须按 path 分组读，不能跨路径比较；真正要看的是模型路径随时间的变化。',
    '提议层判据是弱启发式（语气词与时间/量词在同一句共现），不等于真的给出可执行一步，也会漏判换了说法的合法提议；「F2 事后反馈」页把判为提议的原文摊开供人工复核，别只看布尔列。',
    '提议句摘录与「判为提议」同源：新版数据里「命中但无摘录」应恒为 0，非 0 说明混入了旧版 span，此时多样性 covered 小于提议率分子，两个分母不可直接比较。',
    '任一信号都不构成结论，组合与变化才值得看。用户感知仍不可直接测量：此处只做退化检测，不提供「有效率」，也不把任何单一数字当作效果证明。',
  ].join(' ');
  return { days: windowDays, since, total, staleSpansSkipped, byPath, divergence, note };
}

const FEEDBACK_KIND_LABEL: Record<string, string> = {
  morning: '每日晨报',
  weekly: '本周复盘',
  reminder_due: '到期提醒',
  nudge: '关怀提醒',
};

/** 把反馈汇总成一句给用户的「越用越懂你」提示；信号不足返回 null */
export function summarizeFeedback(owner: string): string | null {
  const fb = getProactiveFeedback(owner);
  for (const [kind, c] of Object.entries(fb)) {
    const total = c.seen + c.dismissed;
    if (total < 2) continue;
    const label = FEEDBACK_KIND_LABEL[kind] || kind;
    if (c.dismissed > c.seen) return `你常划掉「${label}」，我之后会更克制一些`;
    if (c.seen >= c.dismissed * 2 && c.seen >= 2) return `你挺受用「${label}」，我会继续保持`;
  }
  return null;
}

// ============================================================
