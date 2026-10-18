import { useEffect, useRef } from 'react';
import type { XinglanMood } from './StarSprite';
import './XinglanLight.css';

/**
 * 栖光 · 光体（替代拟人化精灵）
 *
 * 设计原则：**形随事动，不随心情动。**
 * - 只接受"它正在做什么"的信号（等待你 / 正在想 / 正在说 / 在听），
 *   刻意不接 XinglanMood 里的 happy / concerned / sleeping —— 那些是表演出来的情绪，
 *   管家需要的是可靠，不是比你更情绪化。
 * - 没有脸。保留"注视"而非"表情"：鼠标移动时光会转向你（朝向即注意力），
 *   这是从 StarSprite 的 eyeFollow 里唯一值得继承的一笔。
 */
export type LightPhase = 'calm' | 'listening' | 'thinking' | 'speaking' | 'waiting';

interface Props {
  accent?: 'nebula' | 'warm';
  /** 有高风险动作等你确认 → 半边转暖金并定住（不等同于"催促"） */
  waiting?: boolean;
  /** 正在流式回复 → 光朝对话方向淌出 */
  speaking?: boolean;
  /** 正在听（语音输入） */
  listening?: boolean;
  /** 仅用于兜底识别 thinking；其余 mood 一律忽略 */
  mood?: XinglanMood;
}

export function XinglanLight({ accent = 'nebula', waiting, speaking, listening, mood }: Props) {
  const phase: LightPhase = waiting
    ? 'waiting'
    : speaking
      ? 'speaking'
      : listening
        ? 'listening'
        : mood === 'thinking'
          ? 'thinking'
          : 'calm';

  const wrap = useRef<HTMLDivElement>(null);
  const sheen = useRef<HTMLSpanElement>(null);

  // 朝向：光会转向你（不是表情，是注意力）
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let raf = 0;
    const onMove = (e: MouseEvent) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const el = wrap.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        if (!r.width) return;
        const dx = Math.max(-1, Math.min(1, (e.clientX - (r.left + r.width / 2)) / (r.width * 1.6)));
        const dy = Math.max(-1, Math.min(1, (e.clientY - (r.top + r.height / 2)) / (r.height * 1.6)));
        el.style.setProperty('--lx', `${(dx * 10).toFixed(1)}px`);
        el.style.setProperty('--ly', `${(dy * 10).toFixed(1)}px`);
        if (sheen.current) {
          sheen.current.style.left = `${50 + dx * 24}%`;
          sheen.current.style.top = `${50 + dy * 24}%`;
        }
      });
    };
    window.addEventListener('mousemove', onMove);
    return () => {
      window.removeEventListener('mousemove', onMove);
      cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div ref={wrap} className="xl-light" data-phase={phase} data-accent={accent} aria-hidden>
      <span className="xl-halo" />
      <span className="xl-ring xl-r2" />
      <span className="xl-ring xl-r1" />
      <span className="xl-core" />
      <span ref={sheen} className="xl-sheen" />
      <span className="xl-trail">
        <i />
        <i />
        <i />
        <i />
      </span>
    </div>
  );
}

export default XinglanLight;
