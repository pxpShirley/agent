import { v4 as uuidv4 } from 'uuid';
import { db, now } from './core.js';
import { parseDue } from '../due.js';
import { type RecurRule, parseRecur, humanizeRecur, nextOccurrence, firstOccurrence } from '../recur.js';

/** 待办子步骤（存于 reminders.steps 的 JSON 数组内） */
export interface ReminderStep {
  /** 稳定序号，用于勾选/定位，从 0 递增 */
  seq: number;
  text: string;
  /** 0 未完成 / 1 完成 */
  done: number;
}

export interface ReminderRecord {
  id: string;
  owner: string;
  /** 人类可读原文，仅用于展示；不可用于比较 */
  due_at: string | null;
  /** due_at 归一化后的 epoch ms，可空（无法解析时为 null）。所有判定只用它 */
  due_ts: number | null;
  body: string;
  done: number;
  created_at: string;
  /** 子步骤清单（展示内容，不参与 SQL 比较）；读取时已由 rowToRecord 解析 */
  steps: ReminderStep[];
  /** 周期/习惯规则（NULL=一次性）；结构化，所有生成逻辑只认它 */
  recur_rule: RecurRule | null;
  /** 同一习惯各期共用，用于「打卡=完成后滚到下一期」 */
  series_id: string | null;
  /** 非持久字段：本次调用命中已有提醒（未新建）时为 true */
  deduped?: boolean;
}

/** 归一化：去空白/标点/大小写差异，用于「同一个人 + 同一件事」判重 */
function normReminder(s: string | null | undefined): string {
  return (s || '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。、！？,.!?~～·:：;；'"“”‘’()（）\-—_/\\]/g, '')
    .toLowerCase();
}

/**
 * 把 DB 里的 steps（JSON 文本）解析成结构化子步骤。
 * 容错：列缺失 / 非法 JSON / 非数组 / 字段残缺 都降级为 []，绝不抛错（下游已依赖此行为）。
 */
export function parseSteps(raw: unknown): ReminderStep[] {
  if (!raw) return [];
  let arr: unknown;
  try {
    arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: ReminderStep[] = [];
  for (const it of arr) {
    if (!it || typeof it !== 'object') continue;
    const o = it as Record<string, unknown>;
    const text = typeof o.text === 'string' ? o.text : '';
    if (!text) continue;
    const seq = typeof o.seq === 'number' ? o.seq : out.length;
    const done = o.done === 1 || o.done === true ? 1 : 0;
    out.push({ seq, text, done });
  }
  // 重新编号，保证 seq 连续从 0 递增（避免历史脏数据导致勾选错位）
  return out.map((s, i) => ({ ...s, seq: i }));
}

function rowToRecord(row: Record<string, any>): ReminderRecord {
  return {
    id: String(row.id),
    owner: String(row.owner),
    due_at: row.due_at ?? null,
    due_ts: typeof row.due_ts === 'number' ? row.due_ts : null,
    body: String(row.body ?? ''),
    done: typeof row.done === 'number' ? row.done : 0,
    created_at: String(row.created_at ?? ''),
    steps: parseSteps(row.steps),
    recur_rule: parseRecur(row.recur_rule),
    series_id: row.series_id ?? null,
  };
}

/** 全字段插入（含周期列）；集中一处避免列清单在多处漂移 */
function insertReminder(row: {
  id: string;
  owner: string;
  due_at: string | null;
  due_ts: number | null;
  body: string;
  done: number;
  created_at: string;
  steps: string;
  recur_rule: string | null;
  series_id: string | null;
}): ReminderRecord {
  db.prepare(
    `INSERT INTO reminders (id,owner,due_at,due_ts,body,done,created_at,steps,recur_rule,series_id)
     VALUES (@id,@owner,@due_at,@due_ts,@body,@done,@created_at,@steps,@recur_rule,@series_id)`,
  ).run(row);
  return rowToRecord(row as Record<string, any>);
}

/** 子步骤是否全部完成（空列表视为未完成，避免空待办被直接判满） */
export function stepsProgress(steps: ReminderStep[]): { total: number; done: number; pct: number } {
  const total = steps.length;
  const done = steps.filter((s) => s.done === 1).length;
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  return { total, done, pct };
}

/**
 * 记一条提醒。幂等：同 owner 下若已存在「未完成的同一件事 + 同一时间」，
 * 则复用既有记录而非再插一条（避免重复回复/NLU 重试堆叠相同提醒）。
 * recur 非空时写成周期/习惯提醒：首期 due_ts 由规则算出，due_at 存人类可读文案。
 */
export function addReminder(
  owner: string,
  body: string,
  dueAt?: string | null,
  steps?: Array<{ text: string; done?: number }>,
  recur?: RecurRule | null,
): ReminderRecord {
  const due = dueAt ?? null;
  const nBody = normReminder(body);
  const nDue = normReminder(due);

  const existing = db
    .prepare('SELECT * FROM reminders WHERE owner = ? AND done = 0 ORDER BY created_at DESC LIMIT 200')
    .all(owner) as Array<Record<string, any>>;
  // 完全同 body（时间一致或新提醒没给时间）视为同一条
  const dup = existing.find(
    (r) => normReminder(r.body) === nBody && (due === null || nDue === '' || normReminder(r.due_at) === nDue),
  );
  if (dup) return { ...rowToRecord(dup), deduped: true };

  // 语义去重：模型换个措辞重复设同一件事（「出发去近郊轻出行」vs「出发去近郊轻出行（记得早出避人流）」）
  // 会刷出一堆重复待办。归一化后做**前缀包含**判定（短的是长的前缀即视为同一条）。
  // 注意不能只比「前 N 字符」：归一化会去掉括号，长句的前 N 字会被后半段占据而匹配不上。
  const SIM_HEAD_MIN = 6;
  if (nBody.length >= SIM_HEAD_MIN) {
    const near = existing.find((r) => {
      const rb = normReminder(r.body);
      if (!rb.length) return false;
      const short = rb.length <= nBody.length ? rb : nBody;
      const long = rb.length <= nBody.length ? nBody : rb;
      if (short.length < SIM_HEAD_MIN || !long.startsWith(short)) return false;
      return due === null || nDue === '' || normReminder(r.due_at) === nDue || normReminder(r.due_at) === '';
    });
    if (near) return { ...rowToRecord(near), deduped: true };
  }

  const stepsJson = JSON.stringify(
    (steps || []).map((s, i) => ({ seq: i, text: s.text, done: s.done === 1 ? 1 : 0 })),
  );

  // 周期/习惯：首期 due_ts 与 due_at 由规则决定，time 字段（dueAt）不再参与
  let due_ts: number | null = due === null ? null : parseDue(due);
  let due_at_out: string | null = due;
  let recurRuleOut: RecurRule | null = null;
  let seriesId: string | null = null;
  if (recur) {
    // count → remaining 的唯一换算点：调用方（工具/探针）只给 count，剩余次数在此归一化
    if (typeof recur.count === 'number' && recur.count > 0 && recur.remaining === undefined) {
      recur = { ...recur, remaining: recur.count - 1 };
    }
    recurRuleOut = recur;
    due_ts = firstOccurrence(recur);
    due_at_out = humanizeRecur(recur);
    seriesId = uuidv4();
  }

  const row: Parameters<typeof insertReminder>[0] = {
    id: uuidv4(),
    owner,
    due_at: due_at_out,
    due_ts,
    body,
    done: 0,
    created_at: now(),
    steps: stepsJson,
    recur_rule: recurRuleOut ? JSON.stringify(recurRuleOut) : null,
    series_id: seriesId,
  };
  return insertReminder(row);
}

export function listReminders(owner: string, includeDone = false): ReminderRecord[] {
  const sql = includeDone
    ? 'SELECT * FROM reminders WHERE owner = ? ORDER BY done ASC, created_at DESC'
    : 'SELECT * FROM reminders WHERE owner = ? AND done = 0 ORDER BY created_at DESC';
  return (db.prepare(sql).all(owner) as Array<Record<string, any>>).map(rowToRecord);
}

export function completeReminder(id: string): boolean {
  const ok = db.prepare('UPDATE reminders SET done = 1 WHERE id = ?').run(id).changes > 0;
  if (ok) maybeRollForward(id);
  return ok;
}

/**
 * 周期/习惯提醒「打卡」：本期完成后按规则生成下一期。
 * - 一次性提醒（无 recur_rule）→ 不做任何事；
 * - count 限定（remaining 递减）：归零后停止生成，习惯自然结束；
 * - 下一期 steps 清零、done=0、沿用原 series_id、due_ts 由规则算出。
 * 集中在此一处，toggleReminderStep 全部勾完 → maybeAutoComplete → completeReminder 自然联动。
 */
function maybeRollForward(id: string): void {
  const rec = getReminderById(id);
  if (!rec || !rec.recur_rule) return;
  const rule = rec.recur_rule;
  if (typeof rule.remaining === 'number' && rule.remaining <= 0) return; // 次数用尽，结束
  const nextTs = nextOccurrence(rule, rec.due_ts ?? Date.now());
  if (nextTs === null) return;
  const newRemaining = typeof rule.remaining === 'number' ? rule.remaining - 1 : undefined;
  const nextRule: RecurRule = { ...rule };
  if (newRemaining !== undefined) nextRule.remaining = newRemaining;
  const stepsJson = JSON.stringify(
    rec.steps.map((s, i) => ({ seq: i, text: s.text, done: 0 })),
  );
  insertReminder({
    id: uuidv4(),
    owner: rec.owner,
    due_at: humanizeRecur(nextRule),
    due_ts: nextTs,
    body: rec.body,
    done: 0,
    created_at: now(),
    steps: stepsJson,
    recur_rule: JSON.stringify(nextRule),
    series_id: rec.series_id || uuidv4(),
  });
}

export function deleteReminder(id: string): boolean {
  return db.prepare('DELETE FROM reminders WHERE id = ?').run(id).changes > 0;
}

/** 把 epoch ms 渲染成「M月D日 HH:mm」人类可读文案（顺延一次性提醒时刷新 due_at 用） */
function formatDueTs(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 顺延一条待办：把 due_ts 整体后移 deltaMs。
 * - 周期/习惯提醒（recur_rule 非空）：保留人类可读的「每周一、三、五 08:30」文案，
 *   只移动结构化 due_ts（顺延后若再「打卡」，下一期由规则从新 due_ts 续算）。
 * - 一次性提醒：同步刷新 due_at 文案，让展示与唯一判定基准（due_ts）保持一致。
 * 只认 due_ts，不改文字比较逻辑。返回 false 表示记录不存在。
 */
export function snoozeReminder(id: string, deltaMs: number): boolean {
  const rec = getReminderById(id);
  if (!rec) return false;
  const base = rec.due_ts ?? Date.now();
  const newTs = base + deltaMs;
  let newDueAt = rec.due_at;
  if (!rec.recur_rule) newDueAt = formatDueTs(newTs);
  db.prepare('UPDATE reminders SET due_ts = @ts, due_at = @at WHERE id = @id').run({
    id,
    ts: newTs,
    at: newDueAt,
  });
  return true;
}

export function getReminderById(id: string): ReminderRecord | undefined {
  const row = db.prepare('SELECT * FROM reminders WHERE id = ?').get(id) as Record<string, any> | undefined;
  return row ? rowToRecord(row) : undefined;
}

/** 归属安全的待办编辑：仅更新传入字段。返回 null 表示记录不存在 */
export function updateReminder(
  id: string,
  patch: { body?: string; due_at?: string | null },
): ReminderRecord | null {
  const cur = getReminderById(id);
  if (!cur) return null;
  const nextDue = patch.due_at === undefined ? cur.due_at : patch.due_at;
  const nextBody = patch.body ?? cur.body;
  db.prepare('UPDATE reminders SET body=@body, due_at=@due_at, due_ts=@due_ts WHERE id=@id').run({
    id: cur.id,
    body: nextBody,
    due_at: nextDue,
    due_ts: patch.due_at === undefined ? cur.due_ts : parseDue(nextDue),
  });
  return getReminderById(id) ?? null;
}

/**
 * 全量设置某待办子步骤。入参只给 text（或带 done）即可，序号由函数统一重排。
 * 全部完成 → 自动把待办置为 done=1（子步骤即待办的完成定义）。
 * 返回最新记录；id 不存在返回 null。
 */
export function setReminderSteps(
  id: string,
  steps: Array<{ text: string; done?: number }>,
): ReminderRecord | null {
  const cur = getReminderById(id);
  if (!cur) return null;
  const next = (steps || []).map((s, i) => ({
    seq: i,
    text: String(s.text || '').trim(),
    done: s.done === 1 ? 1 : 0,
  })).filter((s) => s.text);
  db.prepare('UPDATE reminders SET steps = ? WHERE id = ?').run(JSON.stringify(next), id);
  const rec = getReminderById(id)!;
  maybeAutoComplete(rec);
  return getReminderById(id) ?? null;
}

/** 追加一条子步骤（序号自动排在末尾） */
export function addReminderStep(id: string, text: string): ReminderRecord | null {
  const cur = getReminderById(id);
  if (!cur) return null;
  if (!text.trim()) return cur;
  return setReminderSteps(id, [...cur.steps.map((s) => ({ text: s.text, done: s.done })), { text: text.trim() }]);
}

/** 勾选/取消某条子步骤（按 seq 定位）。全部完成自动置 done=1。 */
export function toggleReminderStep(id: string, seq: number, force?: boolean): ReminderRecord | null {
  const cur = getReminderById(id);
  if (!cur) return null;
  const next = cur.steps.map((s) =>
    s.seq === seq ? { ...s, done: force === undefined ? (s.done === 1 ? 0 : 1) : force ? 1 : 0 } : s,
  );
  return setReminderSteps(id, next);
}

/** 子步骤全部完成则把整条待办标记完成（仅「全部完成」时触发，不反向取消，避免误伤） */
function maybeAutoComplete(rec: ReminderRecord): void {
  const p = stepsProgress(rec.steps);
  if (p.total > 0 && p.done === p.total && rec.done !== 1) {
    completeReminder(rec.id);
  }
}

/**
 * 某 owner 已到期（due_ts <= now 且未完成）的待办。
 * 只认 due_ts：due_at 是自由文本原文，拿它做比较会误报/漏报（见 server/due.ts 说明）。
 */
export function listDueReminders(owner: string): ReminderRecord[] {
  return (
    db
      .prepare(
        'SELECT * FROM reminders WHERE owner = ? AND done = 0 AND due_ts IS NOT NULL AND due_ts <= ? ORDER BY due_ts ASC',
      )
      .all(owner, Date.now()) as Array<Record<string, any>>
  ).map(rowToRecord);
}

/**
 * 存量回填：把迁移前只有 due_at 文本的老行补上 due_ts。
 * 幂等，每次启动跑一次；解析失败的行保持 NULL（不会被判为到期，安全）。
 */
export function backfillDueTs(): number {
  const rows = db
    .prepare("SELECT id, due_at FROM reminders WHERE due_ts IS NULL AND due_at IS NOT NULL AND due_at != ''")
    .all() as Array<{ id: string; due_at: string }>;
  const upd = db.prepare('UPDATE reminders SET due_ts = ? WHERE id = ?');
  let n = 0;
  for (const r of rows) {
    const ts = parseDue(r.due_at);
    if (ts !== null) {
      upd.run(ts, r.id);
      n++;
    }
  }
  return n;
}
