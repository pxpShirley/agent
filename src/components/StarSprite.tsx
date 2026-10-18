import { useEffect, useRef } from 'react';
import './StarSprite.css';

/** 星澜情绪模型（与设计文档 §4.3 / §4.4 单一状态机词汇一致） */
export type XinglanMood =
  | 'calm'        // 平静 · 在场
  | 'listening'   // 聆听 · 眼随你
  | 'thinking'    // 思考 · 思考泡
  | 'speaking'    // 诉说 · 柔弯月眼
  | 'waiting'     // 等待你 · 暖金（人的时刻）
  | 'happy'       // 开心 · 笑眼 + 大微笑
  | 'concerned'   // 担忧 · 嘴角下垂
  | 'sleeping';   // 安睡 · 闭眼

interface Props {
  /** 配色主题：nebula(青紫) / warm(暖金) */
  accent?: 'nebula' | 'warm';
  /** 有高风险动作等你确认 → 整体转金脉动 */
  waiting?: boolean;
  /** 正在说话（流式回复中）→ 眼睛变柔弯月、轻晃，呈现“开口”生命感 */
  speaking?: boolean;
  /** 情绪态（运行时推导，见 §4.3）。提供时优先；否则由 speaking/waiting 兼容推导 */
  mood?: XinglanMood;
  /** 精灵宽度（px），默认 150，匹配 XinglanCore 核心尺寸；高度按画布 200:210 等比 */
  size?: number;
  /** 眼睛是否随鼠标转向你，默认开 */
  eyeFollow?: boolean;
  onClick?: () => void;
  className?: string;
  title?: string;
}

/**
 * 星澜 · 拟人化精灵（StarSprite）
 * 圆润 mochi 体 + 小脚 + 大而柔的眼睛(双高光) + 腮红 + 安心小嘴 + 头顶柔星 + 圆点微光。
 * 生命感：呼吸缩放 + 周期眨眼 + 眼睛随鼠标转向 + 待确认转金 + 说话时柔弯月眼。
 * 配色通过 CSS 变量(--ss1..--ss4/--ss-glow) 驱动，data-accent / data-waiting / data-speaking 切换。
 */
export function StarSprite({
  accent = 'nebula',
  waiting = false,
  speaking = false,
  mood,
  size = 150,
  eyeFollow = true,
  onClick,
  className = '',
  title = '栖光',
}: Props) {
  const eyesRef = useRef<SVGGElement>(null);

  // 情绪态：显式 mood 优先；否则由既有 speaking/waiting 兼容推导（保证旧接线不破）
  const safeMood: XinglanMood = mood ?? (waiting ? 'waiting' : speaking ? 'speaking' : 'calm');

  useEffect(() => {
    if (!eyeFollow) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) return;
    const onMove = (e: MouseEvent) => {
      const g = eyesRef.current;
      const wrap = g?.ownerSVGElement?.parentElement;
      if (!g || !wrap) return;
      const r = wrap.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const dx = Math.max(-3, Math.min(3, (e.clientX - cx) / 42));
      const dy = Math.max(-2.4, Math.min(2.4, (e.clientY - cy) / 50));
      g.style.transform = `translate(${dx}px, ${dy}px)`;
    };
    window.addEventListener('mousemove', onMove);
    return () => window.removeEventListener('mousemove', onMove);
  }, [eyeFollow]);

  return (
    <div
      className={`star-sprite ${className}`}
      data-accent={accent}
      data-mood={safeMood}
      data-waiting={safeMood === 'waiting' ? 'true' : 'false'}
      data-speaking={safeMood === 'speaking' ? 'true' : 'false'}
      style={{ width: size, height: Math.round(size * 1.05) }}
      onClick={onClick}
      title={title}
      role="img"
      aria-label={title}
    >
      <svg viewBox="0 0 200 210" width="100%" height="100%" preserveAspectRatio="xMidYMid meet">
        <defs>
          <radialGradient id="ssGrad" cx="44%" cy="30%" r="82%">
            <stop offset="0%" stopColor="#ffffff" />
            <stop offset="30%" stopColor="#eaf8ff" />
            <stop offset="66%" stopColor="#bfe8ff" />
            <stop offset="100%" stopColor="rgba(95,208,255,0.34)" />
          </radialGradient>
          <radialGradient id="ssBelly" cx="50%" cy="42%" r="56%">
            <stop offset="0%" stopColor="rgba(255,255,255,0.85)" />
            <stop offset="100%" stopColor="rgba(255,255,255,0)" />
          </radialGradient>
        </defs>

        {/* 小脚 */}
        <ellipse className="ss-foot" cx="71" cy="190" rx="17" ry="10" fill="url(#ssGrad)" />
        <ellipse className="ss-foot" cx="129" cy="190" rx="17" ry="10" fill="url(#ssGrad)" />
        {/* 身体 */}
        <path
          className="ss-body"
          d="M100 26 C150 26 175 64 175 108 C175 153 150 192 100 196 C50 192 25 153 25 108 C25 64 50 26 100 26 Z"
          fill="url(#ssGrad)"
        />
        {/* 柔和肚皮高光（体积感，非洞） */}
        <ellipse cx="100" cy="118" rx="42" ry="50" fill="url(#ssBelly)" opacity="0.5" />

        {/* 腮红 */}
        <ellipse className="ss-cheek" cx="58" cy="118" rx="12" ry="7.5" />
        <ellipse className="ss-cheek" cx="142" cy="118" rx="12" ry="7.5" />
        {/* 眼睛（随鼠标转） */}
        <g className="ss-eyes" ref={eyesRef}>
          <g className="ss-eye">
            <ellipse className="ss-eyeball" cx="80" cy="100" rx="9.2" ry="12" />
            <circle cx="83.4" cy="95" r="3.4" fill="#fff" />
            <circle cx="77" cy="104" r="1.7" fill="rgba(255,255,255,0.75)" />
            {/* 说话 / 开心时呈现的柔弯月眼（默认隐藏） */}
            <path className="ss-eye-arc" d="M70 101 Q80 92 90 101" />
            {/* 安睡闭眼（默认隐藏） */}
            <path className="ss-eye-closed" d="M70 104 Q80 110 90 104" />
          </g>
          <g className="ss-eye">
            <ellipse className="ss-eyeball" cx="120" cy="100" rx="9.2" ry="12" />
            <circle cx="123.4" cy="95" r="3.4" fill="#fff" />
            <circle cx="117" cy="104" r="1.7" fill="rgba(255,255,255,0.75)" />
            <path className="ss-eye-arc" d="M110 101 Q120 92 130 101" />
            <path className="ss-eye-closed" d="M110 104 Q120 110 130 104" />
          </g>
        </g>
        {/* 眉毛（思考 / 担忧时浮现，默认隐藏） */}
        <path className="ss-brow" d="M68 88 Q80 83 92 88" />
        <path className="ss-brow" d="M108 88 Q120 83 132 88" />
        {/* 小嘴：安心微笑（默认）；下方为情绪变体（默认隐藏） */}
        <path className="ss-mouth" d="M92 118 Q100 125 108 118" />
        <path className="ss-mouth-grin" d="M86 119 Q100 136 114 119" />
        <path className="ss-mouth-sad" d="M92 127 Q100 121 108 127" />
        <path className="ss-mouth-small" d="M94 122 Q100 124 106 122" />
        {/* 思考泡（思考时浮现，默认隐藏） */}
        <g className="ss-think">
          <circle cx="150" cy="52" r="3" />
          <circle cx="162" cy="64" r="3" />
          <circle cx="150" cy="76" r="3" />
        </g>
        {/* 头顶柔星（品牌印记） */}
        <g transform="translate(100 16)">
          <g className="ss-forestar">
            <path d="M0 -7 L1.8 -1.8 L7 0 L1.8 1.8 L0 7 L-1.8 1.8 L-7 0 L-1.8 -1.8 Z" fill="#fff" opacity="0.92" />
          </g>
        </g>
        {/* 漂浮微光（圆点更柔和） */}
        <circle className="ss-spark" cx="160" cy="72" r="3.2" fill="#fff" opacity="0.7" />
        <circle className="ss-spark" cx="42" cy="86" r="2.6" fill="#fff" opacity="0.6" style={{ animationDelay: '1.2s' }} />
      </svg>
    </div>
  );
}
