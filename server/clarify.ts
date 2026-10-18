/**
 * 「空泛反问」护栏 —— 能力层，不是提示词层。
 *
 * 背景（2026-10-18 实测）：用户说「帮我设个提醒」这类信息不全的话时，
 * 模型约 1/5 概率回一句「提醒什么事？」——把球整个踢回去，没有默认值、没有选项，
 * 用户只能从零开始打字。提示词第 7 条（缺信息时先推断，不要空泛反问）已经改到第三版仍复发，
 * 按本项目既定经验：**同类问题改到第三版还复发，就换能力层硬性切断**。
 *
 * 这里做三件事，全部确定性、可单测、不依赖模型：
 *   1. `isBareQuestion`     判定一句回复是不是「纯空泛反问」；
 *   2. `couldBeBareQuestion` 流式吐字途中「还可能是」的宽判据——引擎用它憋住前几个字，
 *                            免得空话已经展示给用户才补救（补救永远晚一步）；
 *   3. `buildClarification` 真的判成空泛反问时，用**用户自己说过的话**生成
 *                            「推断 + 具体时间 + 可点选选项」的替代回复。
 *
 * ⚠️ 只覆盖「提醒 / 待办」一族（`isReminderish`）。两个原因：
 *    ① 这是实测复发的场景；
 *    ② 这是唯一能**安全**给出具体默认值的一族——缺的只是时间，而时间有常识默认值
 *       （今晚 22:30 / 明早 9:00）。别的一族反问往往是合理的（「查哪个城市？」），
 *       硬给默认值就是编造，交给提示词管。
 *
 * ⚠️ 本文件**零 import**：evals 与引擎共用同一份判据（单一真相源），
 *    任何依赖都会把单元探针拖进数据库初始化。
 */

/** 观察窗：超过这个长度的回复不可能是「纯空泛反问」，直接放行 */
export const BARE_MAX_LEN = 40;

/**
 * 把球整个踢回给用户的话术。
 *
 * ⚠️ `evals/cases.ts` 的 EMPTY_QUESTION 直接复用本数组——判据只有这一份，
 *    避免「eval 禁一批话术、护栏放另一批」。
 */
export const BARE_QUESTION_PHRASES = [
  '提醒什么事',
  '提醒什么内容',
  '什么提醒',
  '请告诉我具体',
  '你想提醒什么',
  '需要提醒什么',
  '请问要提醒',
  '你想让我做什么',
  '能具体说说吗',
  '想说什么',
  '是什么事',
  '什么事',
  '什么时候',
  '哪个时间',
  '想什么时候',
  '要做什么',
  '想做什么',
];

/**
 * 回复里是否已经给了「具体默认值」。
 * 判据是时间词与数字——有它就不是空泛反问（「今晚 22:30 还是明早 9:00？」是合格的澄清）。
 */
const CONCRETE_RE =
  /\d|点半|点钟|[:：]\d{2}|凌晨|清晨|早上|上午|中午|下午|傍晚|晚上|深夜|今晚|明早|明天|今天|后天|大后天|周末|下周|周[一二三四五六日末]|星期[一二三四五六日]|号|每天|每周|每月/;

/** 提醒 / 待办一族的触发词：只有这一族受护栏保护 */
const REMINDERISH_RE = /提醒|待办|备忘|闹钟|日程|别忘了|记一下|记个|打卡|叫我|提示我/;

/** 时间表达：允许缺日期/时段，但必须有「数字 + 点/冒号」才算数 */
const TIME_RE =
  /(?:\d{1,2}\s*月\s*\d{1,2}\s*[号日]|今天|今晚|明早|明天|后天|大后天|下周[一二三四五六日]?|周[一二三四五六日]|星期[一二三四五六日]|每天|每周|每月)?\s*(?:凌晨|清晨|早上|上午|中午|下午|傍晚|晚上|深夜)?\s*\d{1,2}\s*(?:点|:|：)\s*(?:\d{1,2})?/;

export interface ClarifyCtx {
  /** 本轮用户原话 */
  message: string;
  /** 最近几轮用户原话（旧→新），用于把上文说过的时间/事件捡回来当推断依据 */
  history?: string[];
}

export interface Clarification {
  /** 替代回复（保证不含任何 BARE_QUESTION_PHRASES，也保证带具体时间） */
  text: string;
  /** 可点选选项：点一下即作为用户消息发出，故每条都是完整句子 */
  choices: string[];
}

/** 回复里是否已有具体默认值（时间词或数字） */
export function hasConcreteDefault(text: string): boolean {
  return CONCRETE_RE.test(String(text || ''));
}

/** 本轮请求是否属于「提醒 / 待办」一族（护栏的准入条件） */
export function isReminderish(text: string): boolean {
  return REMINDERISH_RE.test(String(text || ''));
}

/**
 * 这句回复是不是「纯空泛反问」：短、没有任何具体默认值、且整句就是在把球踢回去。
 *
 * 三条都必须满足，宁可漏判也不要误判——误判会把模型正常的一句短问话替换成罐头文案。
 */
export function isBareQuestion(text: string): boolean {
  const t = String(text || '').trim();
  if (!t) return false;
  if (t.length > BARE_MAX_LEN) return false; // 长回复给了内容，不算纯反问
  if (hasConcreteDefault(t)) return false; // 已经给了具体默认值，正是我们想要的行为
  if (BARE_QUESTION_PHRASES.some((p) => t.includes(p))) return true;
  // 结构性兜底：以问号收尾 + 带疑问词（话术库不可能穷尽，形状要能兜住）
  return /[？?]$/.test(t) && /什么|哪|谁|几|吗|呢|咋/.test(t);
}

/**
 * 流式途中的宽判据：这句话**还可能是**空泛反问吗？
 * 引擎据此决定「继续憋住」还是「转直通逐字吐」。
 *
 * 必须是 `isBareQuestion` 的超集：宁可多憋几个字，也不能把该拦的放过去。
 */
export function couldBeBareQuestion(text: string, ctx: ClarifyCtx): boolean {
  if (!isReminderish(ctx.message)) return false; // 别的族不保护，也就没有憋字的必要
  const t = String(text || '');
  if (t.length > BARE_MAX_LEN) return false; // 超出观察窗，已不可能是纯反问
  return !hasConcreteDefault(t); // 一出现具体时间/数字就放行
}

/** 从候选文本里取第一个可读的时间表达（原样引用，不做归一化——它已经是人话） */
function pickTime(candidates: string[]): string | null {
  for (const c of candidates) {
    const m = TIME_RE.exec(String(c || ''));
    if (m && /\d/.test(m[0])) {
      const t = m[0].replace(/\s+/g, '');
      if (t) return t;
    }
  }
  return null;
}

/** 从一句话里剥出「要记的那件事」：去掉时间、去掉客套与主观动词，截断到 20 字 */
function pickSubject(raw: string): string | null {
  let s = String(raw || '');
  s = s.replace(TIME_RE, '');
  s = s.replace(/^(嗯|呃|啊|那个|就是|然后|接着|另外|还有)/, '');
  s = s.replace(/(帮我|帮忙|请|给我|替我)/g, '');
  s = s.replace(/(我|你|他|她)?(要|得|想|必须|应该|打算|计划|需要|记得|记住)/g, '');
  s = s.replace(/(设个?|设一个|定个?|定一个|建个?|添加一个?|新增一个?|加一个?)/g, '');
  s = s.replace(/(提醒|待办|备忘|闹钟|日程|记事|记一下|记着|告诉我|说一下)/g, '');
  s = s.replace(/[，。、！？；：\s~～的啊了呢吧嘛]+/g, '');
  s = s.replace(/^(去|来|做|搞|弄)/, '');
  if (!s) return null;
  return s.length > 20 ? `${s.slice(0, 20)}…` : s;
}

/**
 * 生成替代回复：用用户自己说过的话做推断，捡不到就给常识默认值。
 *
 * 硬约束（探针逐条断言）：
 *   - 文案**不得**包含任何 BARE_QUESTION_PHRASES——否则等于换了个说法的空泛反问；
 *   - 文案**必须**带具体时间（`hasConcreteDefault`）——这是第 7 条的核心；
 *   - choices 每条都是完整句子：点一下直接当用户消息发出去，不需要用户再补字。
 */
export function buildClarification(ctx: ClarifyCtx): Clarification {
  const msg = String(ctx.message || '');
  const hist = (ctx.history || []).filter((h) => String(h || '').trim());
  // 本轮优先，其次上文；时间与事件都遵循同一优先级
  const candidates = [msg, ...hist.slice().reverse()];
  const timeGuess = pickTime(candidates);
  const subjectGuess = pickSubject(candidates.find((c) => pickSubject(c)) || '');

  const when = timeGuess || '今晚 22:30';
  const what = subjectGuess ? ` · ${subjectGuess}` : '';

  if (timeGuess && subjectGuess) {
    return {
      text: `那就先按 ${when}${what} 记上。要换时间、或者要提醒的其实是别的事，说一声我就改。`,
      choices: [`就按${timeGuess}，${subjectGuess}`, '改到明早 9:00', '改到今晚 22:30', '不是这件事，我重新说'],
    };
  }
  if (timeGuess) {
    return {
      text: `时间看到了：${when}。要提醒的是哪件事？从下面挑一个，或者直接说给我听，我马上记。`,
      choices: [`${timeGuess} 提醒我喝水`, `${timeGuess} 提醒我吃早餐`, `${timeGuess} 提醒我取快递`, '不是这些，我说一件事你记一下'],
    };
  }
  if (subjectGuess) {
    return {
      text: `要记的是：${subjectGuess}。时间没明说，我按 ${when} 先记上；要换就说一声。`,
      choices: [`就按今晚 22:30，${subjectGuess}`, '改到明早 9:00', '改到周末上午 10:00', '我自己说时间'],
    };
  }
  return {
    text: `没看到具体是哪件事，我先按最常见的猜了一个：${when} · 提醒我早点休息。要提醒的如果是别的事，从下面挑一个，或者直接说「事 + 时间」，我马上重设。`,
    choices: ['今晚 22:30 提醒我喝水', '明早 9:00 提醒我吃早餐', '周末上午 10:00 提醒我大扫除', '不是这些，我说一件事你记一下'],
  };
}

/**
 * 护栏总入口：引擎在「最后一轮纯文本」处调用。
 * 返回 `repaired: false` 表示这句回复没问题，原样展示。
 */
export function guardBareQuestion(
  text: string,
  ctx: ClarifyCtx
): { repaired: false } | ({ repaired: true } & Clarification) {
  if (!isReminderish(ctx.message)) return { repaired: false };
  if (!isBareQuestion(text)) return { repaired: false };
  const c = buildClarification(ctx);
  return { repaired: true, text: c.text, choices: c.choices };
}
