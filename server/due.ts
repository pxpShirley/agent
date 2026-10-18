/**
 * 时间归一化：把模型/用户给的**自由文本**时间描述解析成可比较的 epoch ms。
 *
 * 存在的理由（架构硬约束）：模型自由文本**不得**直接进入判定链路。
 * `reminders.due_at` 存的是原文（`'10月7日 晚上 22:30'`、`'明天 9 点'`），
 * 拿它去做字符串比较或 `new Date()` 会得到误报/NaN。
 * 因此写入时必须同时算出 `due_ts`（结构化、可比较），原文另存一列仅供展示。
 *
 * 解析失败一律返回 null（宁可「不知道什么时候」，也不要编一个假时间触发误提醒）。
 */

const CN_DIGITS: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};

/** 支持 `十` / `十五` / `二十` / `二十三`，以及纯阿拉伯数字 */
function cnNumber(s: string): number | null {
  const t = String(s || '').trim();
  if (!t) return null;
  if (/^\d+$/.test(t)) return Number(t);
  if (/^[零〇一二两三四五六七八九]?十[一二三四五六七八九]?$/.test(t)) {
    const tens = t.startsWith('十') ? 1 : (CN_DIGITS[t[0]] ?? 0);
    const onesIdx = t.indexOf('十') + 1;
    const ones = onesIdx < t.length ? (CN_DIGITS[t[onesIdx]] ?? 0) : 0;
    return tens * 10 + ones;
  }
  if (/^[零〇一二两三四五六七八九十]+$/.test(t)) {
    let n = 0;
    for (const ch of t) n = n * 10 + (CN_DIGITS[ch] ?? 0);
    return n;
  }
  return null;
}

const NUM = String.raw`(\d{1,2}|[零〇一二两三四五六七八九十]+)`;

/** 12 小时制的时段修饰：晚上/下午等 → 小时 +12（24 小时写法如「晚上 22:30」不加） */
function meridiemShift(s: string): number {
  return /晚上|夜里|下午|傍晚|今晚|明晚|中午/.test(s) ? 12 : 0;
}

/** 抽取「时:分」或「X点(半|X分)」，返回 24 小时制 */
function extractTime(s: string): { h: number; m: number } | null {
  const shift = meridiemShift(s);
  const colon = s.match(new RegExp(`${NUM}\\s*[:：]\\s*(\\d{1,2})`));
  if (colon) {
    let h = cnNumber(colon[1]) ?? -1;
    const m = cnNumber(colon[2]) ?? -1;
    if (shift && h >= 0 && h < 12) h += 12;
    if (h >= 0 && h <= 23 && m >= 0 && m <= 59) return { h, m };
  }
  const oclock = s.match(new RegExp(`${NUM}\\s*点(半|${NUM}\\s*分?)?`));
  if (oclock) {
    let h = cnNumber(oclock[1]) ?? -1;
    let m = 0;
    if (oclock[2] === '半') m = 30;
    else if (oclock[3]) m = cnNumber(oclock[3]) ?? 0;
    if (shift && h >= 0 && h < 12) h += 12;
    if (h >= 0 && h <= 23 && m >= 0 && m <= 59) return { h, m };
  }
  return null;
}

const WEEKDAY_CN = ['日', '一', '二', '三', '四', '五', '六'];

/** 解析「周一 / 星期三 / 周末」，返回下一个该星期几的 00:00 */
function nextWeekday(s: string, from: Date): Date | null {
  const m = s.match(/(?:周|星期)\s*([一二三四五六日天末])/);
  if (!m) return null;
  const ch = m[1];
  const out = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  if (ch === '末') {
    // 周末 → 取最近的周六
    const delta = (6 - out.getDay() + 7) % 7 || 7;
    out.setDate(out.getDate() + delta);
    return out;
  }
  const idx = WEEKDAY_CN.indexOf(ch === '天' ? '日' : ch);
  if (idx < 0) return null;
  const delta = (idx - out.getDay() + 7) % 7 || 7; // 同一天则取下周
  out.setDate(out.getDate() + delta);
  return out;
}

/**
 * 解析自由文本时间为 epoch ms；无法解析返回 null。
 * @param raw 原始描述，如 `明天 9 点` / `10月7日 晚上 22:30` / `2026-10-07 22:30` / `22:30`
 * @param nowRef 基准「现在」，仅用于相对日期推算与测试注入
 */
export function parseDue(raw: string | null | undefined, nowRef: Date = new Date()): number | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s) return null;

  // 1) 标准可解析格式（ISO / '2026-10-07 22:30' / 'Oct 7 2026' ...）
  const direct = Date.parse(s);
  if (!Number.isNaN(direct)) return direct;

  const today = new Date(nowRef.getFullYear(), nowRef.getMonth(), nowRef.getDate());
  const addDays = (n: number) => {
    const d = new Date(today);
    d.setDate(d.getDate() + n);
    return d;
  };

  // 2) 相对日
  let base: Date | null = null;
  if (/今天|今日|今晚|今早|今晨/.test(s)) base = today;
  else if (/大后天/.test(s)) base = addDays(3);
  else if (/后天/.test(s)) base = addDays(2);
  else if (/明天|明日|明早|明晚/.test(s)) base = addDays(1);

  // 3) 绝对日期：10月7日 / 10/7
  if (!base) {
    const md = s.match(new RegExp(`${NUM}\\s*月\\s*${NUM}\\s*[日号]?`)) || s.match(/(\d{1,2})\s*\/\s*(\d{1,2})/);
    if (md) {
      const mo = cnNumber(md[1]);
      const dy = cnNumber(md[2]);
      if (mo && dy && mo >= 1 && mo <= 12 && dy >= 1 && dy <= 31) {
        const cand = new Date(nowRef.getFullYear(), mo - 1, dy);
        // 明显已过去（超过 30 天）视为明年，避免「12月」跨年时恒判为逾期
        if (cand.getTime() < today.getTime() - 30 * 86_400_000) cand.setFullYear(nowRef.getFullYear() + 1);
        base = cand;
      }
    }
  }

  // 4) 星期
  if (!base) base = nextWeekday(s, today);

  const t = extractTime(s);

  // 5) 只有时间、没有任何日期线索：按今天的该时刻；若已过则顺延到明天。
  //    但必须确认剩下的文字里没有其它未识别内容（如「最后一天 22:30」），
  //    否则宁可返回 null —— 瞎猜一个日期会触发错误的到期提醒。
  if (!base) {
    if (!t) return null;
    const leftover = s
      .replace(new RegExp(`${NUM}\\s*[:：]\\s*\\d{1,2}`), '')
      .replace(new RegExp(`${NUM}\\s*点(半|${NUM}\\s*分?)?`), '')
      .replace(/早上|上午|中午|下午|傍晚|晚上|夜里|凌晨|点|钟|左右|前后|之前|之后|前|后/g, '')
      .replace(/[\s，。、,.:：;；]/g, '');
    // 还有 3 个以上残字（如「最后一天 22:30」「某个周末 10 点」）就说明日期没说清，
    // 宁可返回 null，也不要拿「今天」去猜一个日期触发错误的到期提醒。
    if (leftover.length >= 3) return null;
    if (/最|第|末|某|待定|再看|回头|以后|找个/.test(leftover)) return null;
    const cand = new Date(today);
    cand.setHours(t.h, t.m, 0, 0);
    return cand.getTime() <= nowRef.getTime() ? cand.getTime() + 86_400_000 : cand.getTime();
  }

  base.setHours(t ? t.h : 9, t ? t.m : 0, 0, 0); // 有日期没时刻 → 默认早上 9 点
  return base.getTime();
}
