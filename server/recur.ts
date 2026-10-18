/**
 * 周期 / 习惯提醒规则（B2 能力扩张）
 *
 * 设计纪律（沿用架构硬约束）：模型自由文本**不得**直接进入判定链路。
 * 周期意图（「每天」「每周一三五」「每月 1 号」）必须由工具显式收成结构化的 RecurRule，
 * 再由 nextOccurrence 算出可比较的 due_ts。绝不用 parseDue 去猜「每天 22:00」里的频率。
 *
 * 数据流：
 *   set_reminder(recur={freq,at,days,dom,count})  → addReminder 写首期 due_ts + recur_rule(JSON)
 *   completeReminder(某期)                          → maybeRollForward 算下一期 due_ts 并插新行（同 series_id）
 *   判定（listDueReminders / scheduler / 前端逾期）只认 due_ts，与一次性提醒完全一致。
 */
export interface RecurRule {
  /** 重复频率 */
  freq: 'daily' | 'weekly' | 'monthly';
  /** 每天/每周的触发时刻 "HH:MM"，默认 "09:00" */
  at?: string;
  /** weekly 用：星期几数组，0=周日…6=周六 */
  days?: number[];
  /** monthly 用：每月几号，1-31 */
  dom?: number;
  /** 限定总次数（如 21 天打卡挑战）；写入时由 addReminder 折成 remaining */
  count?: number;
  /** 剩余次数；归零后不再生成下一期。缺省=无限 */
  remaining?: number;
}

const TIME_RE = /^(\d{1,2}):(\d{2})$/;
const WD_CN = ['日', '一', '二', '三', '四', '五', '六'];

/** 容错解析：列缺失 / 非法 JSON / freq 不对 / 字段残缺 都降级为 null，绝不抛错 */
export function parseRecur(raw: unknown): RecurRule | null {
  if (!raw) return null;
  let o: any;
  try {
    o = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object') return null;
  const freq = o.freq;
  if (freq !== 'daily' && freq !== 'weekly' && freq !== 'monthly') return null;
  const rule: RecurRule = { freq };
  if (typeof o.at === 'string' && TIME_RE.test(o.at.trim())) rule.at = o.at.trim();
  if (freq === 'weekly' && Array.isArray(o.days)) {
    const rawDays = (o.days as unknown[])
      .map((d) => Number(d))
      .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
    if (rawDays.length) rule.days = Array.from(new Set(rawDays)).sort((a, b) => a - b);
  }
  if (freq === 'monthly' && Number.isInteger(o.dom)) {
    const dom = Math.min(31, Math.max(1, o.dom));
    if (dom >= 1) rule.dom = dom;
  }
  if (typeof o.remaining === 'number' && o.remaining >= 0) rule.remaining = o.remaining;
  return rule;
}

function parseAt(at?: string): { h: number; m: number } {
  if (at && TIME_RE.test(at.trim())) {
    const h = Number(at.trim().match(TIME_RE)![1]);
    const m = Number(at.trim().match(TIME_RE)![2]);
    if (h >= 0 && h <= 23 && m >= 0 && m <= 59) return { h, m };
  }
  return { h: 9, m: 0 }; // 兜底默认早上 9 点
}

function setTime(d: Date, h: number, m: number): number {
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

/** 把规则渲染成人类可读文案：每天 22:00 / 每周一、三、五 08:30 / 每月 1 日 09:00 */
export function humanizeRecur(rule: RecurRule): string {
  const at = rule.at && TIME_RE.test(rule.at) ? rule.at : '09:00';
  if (rule.freq === 'daily') return `每天 ${at}`;
  if (rule.freq === 'weekly') {
    const days = (rule.days && rule.days.length ? rule.days : [1]).slice().sort((a, b) => a - b);
    const s = days.map((d) => WD_CN[((d % 7) + 7) % 7]).join('、');
    return `每周${s} ${at}`;
  }
  if (rule.freq === 'monthly') {
    return `每月 ${rule.dom || 1} 日 ${at}`;
  }
  return at;
}

/**
 * 计算「下一个」触发时刻（epoch ms），严格晚于 fromTs。
 * 同一函数同时服务「首期创建」（fromTs = now-1ms → 取最近一个未来 slot）
 * 与「完成后滚动」（fromTs = 本期 due_ts → 取下一周期），语义统一不漂移。
 */
export function nextOccurrence(rule: RecurRule, fromTs: number): number {
  const { h, m } = parseAt(rule.at);

  if (rule.freq === 'daily') {
    // 先看「今天 at 时刻」是否还没过：没过就取今天（首期创建场景）；
    // 已过或已等于 fromTs 则顺延到明天（打卡后滚下一期场景）。
    const cand = new Date(fromTs);
    cand.setHours(h, m, 0, 0);
    if (cand.getTime() > fromTs) return cand.getTime();
    cand.setDate(cand.getDate() + 1);
    return cand.getTime();
  }

  if (rule.freq === 'weekly') {
    const days = (rule.days && rule.days.length ? rule.days : [1]).slice().sort((a, b) => a - b);
    const base = new Date(fromTs);
    base.setDate(base.getDate() + 1); // 从「明天」开始找，避免同一天重复
    base.setHours(0, 0, 0, 0);
    for (let i = 0; i < 14; i++) {
      if (days.includes(base.getDay())) return setTime(base, h, m);
      base.setDate(base.getDate() + 1);
    }
    return setTime(base, h, m); // 兜底（理论不可达）
  }

  // monthly：从 fromTs 所在月往后逐月找「该月 dom 号 at 时刻」且严格晚于 fromTs 的 slot
  const dom = Math.min(31, Math.max(1, rule.dom || 1));
  const cur = new Date(fromTs);
  cur.setHours(0, 0, 0, 0);
  for (let i = 0; i < 24; i++) {
    const dim = new Date(cur.getFullYear(), cur.getMonth() + 1, 0).getDate(); // 当月天数
    const day = Math.min(dom, dim);
    const cand = new Date(cur.getFullYear(), cur.getMonth(), day, h, m, 0, 0);
    if (cand.getTime() > fromTs) return cand.getTime();
    cur.setMonth(cur.getMonth() + 1);
  }
  return setTime(cur, h, m);
}

/** 首期创建：取「现在之后的第一个 slot」（今天未过则今天，否则顺延） */
export function firstOccurrence(rule: RecurRule, nowTs = Date.now()): number {
  return nextOccurrence(rule, nowTs - 1);
}
