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
