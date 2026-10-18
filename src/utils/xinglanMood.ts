/**
 * 栖光 · 情绪导演（纯函数层）
 *
 * 背景：StarSprite 定义了 8 种情绪（calm/listening/thinking/speaking/waiting/happy/concerned/sleeping），
 * 但此前 XinglanShell 只会机械派生 4 种（waiting → thinking → speaking → calm），
 * happy / concerned / sleeping / listening 全是死状态 —— 形象从没真正"演出"过。
 *
 * 这个文件负责两件事，都是纯函数（便于探针回归，不依赖 React）：
 *   1. moodFromText —— 从助手回话里读出语气：happy / concerned / null
 *   2. decideMood  —— 把运行时信号编排成一个情绪时间线（谁优先、谁让位）
 *
 * 设计纪律：
 *   - 绝不返回 'waiting'。暖金只属于「人的环 / 待你确认」，不能被一句疑问句稀释。
 *     疑问句自己不是情绪，判不出来就 null。
 *   - 「没能完成」必须判 concerned 而不是 happy —— 所以先查负面再查正面（负面优先）。
 *   - 判不出来就 null。宁可不演，也不要演错。
 */
import type { XinglanMood } from '../components/StarSprite';

/** 送达瞬间允许冻结的情绪（其余情绪由运行时信号决定，不由此函数产出） */
export type DeliveryMood = Extract<XinglanMood, 'happy' | 'concerned'>;

/**
 * 负面语气词表。
 * 顺序无关，但**整体优先于正面词表**——「没能完成」同时命中两边的词，
 * 先判负面才能不把失败演成开心。
 */
const CONCERN_PATTERNS: RegExp[] = [
  /没(能|有|法)?(完成|成功|找到|查到|做到|拿到|帮上|搞定|生效)/,
  /未(能|找到|完成|成功|生效)/,
  /不(太)?(确定|清楚|明朗|乐观)/,
  /(失败|出错|报错|异常|超时|中断|遗漏|错过)/,
  /(抱歉|遗憾|不好意思)/,
  /(无法|没法|来不及|赶不上)/,
  /(逾期|过期|已过|延误)/,
  /(需要(你)?注意|特别注意|要小心|当心)/,
  /(风险|隐患|警示|警告)/,
  /(可能(会)?(有)?(问题|影响|来不及))/,
  /(暂时(没|无)|还没(有)?(完成|成功|找到|设置|记录))/,
];

/** 正面语气词表 */
const HAPPY_PATTERNS: RegExp[] = [
  /(完成(了|啦|咯)?)/,
  /(已(经)?(帮你|为你|设置|创建|添加|记录|安排|整理|更新|保存|搞定))/,
  /(成功(了|啦)?)/,
  /(搞定(了|啦)?|弄好了|弄定了|搞好了|做好了|办好了|安排好了|记下了|存好了)/,
  /(没问题|当然可以|当然行|包在我身上|交给我)/,
  /(太好了|真好|不错|很棒|顺利)/,
  /(恭喜|祝贺)/,
  /(一切就绪|已经就绪|都已?就位|准备妥当)/,
  /(祝(你|您)?(一切|顺利|愉快))/,
];

/**
 * 从助手回话读出语气。返回 happy / concerned / null（null = 读不出，不演）。
 */
export function moodFromText(text: string): DeliveryMood | null {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  if (CONCERN_PATTERNS.some((re) => re.test(flat))) return 'concerned';
  if (HAPPY_PATTERNS.some((re) => re.test(flat))) return 'happy';
  return null;
}

/** 形象状态文案：让「栖光 · xxx」跟着情绪走，而不是永远 静候/思考中 */
export const MOOD_LABEL: Record<XinglanMood, string> = {
  calm: '静候',
  listening: '聆听中',
  thinking: '思考中',
  speaking: '诉说中',
  waiting: '等你',
  happy: '为你高兴',
  concerned: '有些在意',
  sleeping: '安睡',
};

/**
 * 演出时间线的运行时信号。
 * 每个字段都由 hook 维护；这里只做"谁压过谁"的裁决。
 */
export interface PerfSignals {
  /** 有待你确认 —— 最高优先级，暖金 */
  waiting: boolean;
  /** 正在收音（语音输入） */
  recording: boolean;
  /** 在想：loading 中或有执行步骤还在跑 */
  thinking: boolean;
  /** 正在流式输出 */
  streaming: boolean;
  /** 送达瞬间冻结的情绪（有生命周期，到期自动消失） */
  frozen: DeliveryMood | null;
  /** 空闲太久 → 安睡 */
  asleep: boolean;
}

/**
 * 情绪裁决：优先级从高到低。
 * waiting > listening > thinking > speaking > 冻结情绪 > sleeping > calm
 *
 * 之所以让 waiting 压过一切：人的时刻是唯一允许用暖金的场合，
 * 且「需要你」不该被一个刚送达的 happy 盖掉。
 */
export function decideMood(s: PerfSignals): XinglanMood {
  if (s.waiting) return 'waiting';
  if (s.recording) return 'listening';
  if (s.thinking) return 'thinking';
  if (s.streaming) return 'speaking';
  if (s.frozen) return s.frozen;
  return s.asleep ? 'sleeping' : 'calm';
}
