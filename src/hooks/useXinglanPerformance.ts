import { useEffect, useMemo, useRef, useState } from 'react';
import type { XinglanMood } from '../components/StarSprite';
import { MOOD_LABEL, decideMood, moodFromText, type DeliveryMood } from '../utils/xinglanMood';

export interface UseXinglanPerformanceOptions {
  /** 请求已发出、尚无内容 */
  loading: boolean;
  /** 正在流式输出 */
  streaming: boolean;
  /** 语音输入收音中 */
  recording: boolean;
  /** 有待你确认（pendingQ） */
  waiting: boolean;
  /** 执行链里还有步骤在跑 */
  agentBusy: boolean;
  /** 最后一条助手文本 */
  lastText: string;
  /** 最后一条助手消息的身份（内容变化但 id 不变 = 流式追加，不算新送达） */
  lastTextKey?: string;
  /** 送达情绪冻结时长（ms），默认 4.2s */
  frozenMs?: number;
  /** 空闲多久后安睡（ms），默认 75s */
  sleepAfterMs?: number;
  /** 关掉安睡（精简模式 / 后台标签页） */
  sleepEnabled?: boolean;
}

export interface XinglanPerformance {
  mood: XinglanMood;
  /** 形象状态文案（「栖光 · xxx」） */
  label: string;
  /** 是否正处在"演出"中（送达后的情绪保持期） */
  performing: boolean;
}

/**
 * 栖光演出编排 hook
 *
 * 把「机械的加载标志」翻译成一条有起伏的情绪时间线：
 *   待你确认 → 聆听 → 思考 → 诉说 →【送达瞬间定格 happy / concerned】→ 静候 → 久了安睡
 *
 * 关键设计：
 *   - 情绪只在**送达那一刻**定格（消息 id 变化 或 流式结束），并保持 frozenMs 后自然回落 calm。
 *     流式过程中文本每变一次都重判，会导致表情抽搐。
 *   - 定格期间任何新信号（又开始想/说/等你）都会按优先级盖过它，不会卡住脸。
 *   - 空闲计时只在"没有任何信号"时启动；一有动静就重置，避免读到一半睡着。
 */
export function useXinglanPerformance(o: UseXinglanPerformanceOptions): XinglanPerformance {
  const frozenMs = o.frozenMs ?? 4200;
  const sleepAfterMs = o.sleepAfterMs ?? 75_000;
  const sleepEnabled = o.sleepEnabled !== false;

  const busy = o.waiting || o.recording || o.loading || o.agentBusy || o.streaming;

  /* —— 送达定格：只在"新消息 / 流式结束"时判定一次 —— */
  const [frozen, setFrozen] = useState<DeliveryMood | null>(null);
  const prevKey = useRef<string | undefined>(o.lastTextKey);
  const prevStream = useRef<boolean>(o.streaming);

  useEffect(() => {
    const keyChanged = prevKey.current !== o.lastTextKey;
    const justSettled = prevStream.current && !o.streaming;
    prevKey.current = o.lastTextKey;
    prevStream.current = o.streaming;
    // 流式途中不定格：首句就命中"完成"会把表情提前演掉，等说完那一刻再判
    if (o.streaming && !justSettled) return;
    if (!keyChanged && !justSettled) return;

    const tone = moodFromText(o.lastText);
    if (!tone) return;
    setFrozen(tone);
    const t = window.setTimeout(() => setFrozen(null), frozenMs);
    return () => window.clearTimeout(t);
    // lastText 故意不入 deps：流式期间它每帧都变，入 deps 会让定格被反复打断
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [o.lastTextKey, o.streaming, frozenMs]);

  /* —— 安睡：只在彻底空闲后计时，一有动静立刻醒 —— */
  const [asleep, setAsleep] = useState(false);
  useEffect(() => {
    if (!sleepEnabled) { setAsleep(false); return; }
    if (busy) { setAsleep(false); return; }
    const t = window.setTimeout(() => setAsleep(true), sleepAfterMs);
    return () => window.clearTimeout(t);
  }, [busy, o.lastTextKey, sleepAfterMs, sleepEnabled]);

  const mood = useMemo(
    () =>
      decideMood({
        waiting: o.waiting,
        recording: o.recording,
        thinking: o.loading || o.agentBusy,
        streaming: o.streaming,
        frozen,
        asleep,
      }),
    [o.waiting, o.recording, o.loading, o.agentBusy, o.streaming, frozen, asleep],
  );

  return { mood, label: MOOD_LABEL[mood], performing: frozen !== null };
}
