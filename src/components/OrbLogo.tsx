interface Props {
  size?: number;
  className?: string;
}

/** 栖光 · 品牌光符：栖止的光 —— 发光核心 + 柔晕光环 + 地平弧线，温柔在侧的 AI 管家标识 */
export function OrbLogo({ size = 32, className = '' }: Props) {
  const uid = 'glow-orb';
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      className={`orb ${className}`}
      role="img"
      aria-label="栖光"
    >
      <defs>
        <linearGradient id={`${uid}-c`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#6fe9ff" />
          <stop offset="100%" stopColor="#7af0d4" />
        </linearGradient>
        <filter id={`${uid}-glow`} x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="2.4" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      <g filter={`url(#${uid}-glow)`}>
        {/* 地平弧线：栖光栖止之处 */}
        <path
          d="M14 40 Q32 56 50 40"
          fill="none"
          stroke={`url(#${uid}-c)`}
          strokeWidth="2.6"
          strokeLinecap="round"
          opacity="0.75"
        />
        {/* 发光核心 */}
        <circle cx="32" cy="30" r="9" fill={`url(#${uid}-c)`} />
        {/* 柔晕光环 */}
        <circle cx="32" cy="30" r="15" fill="none" stroke={`url(#${uid}-c)`} strokeWidth="1.2" opacity="0.35">
          <animate attributeName="opacity" values="0.22;0.5;0.22" dur="3.6s" repeatCount="indefinite" />
        </circle>
      </g>
    </svg>
  );
}

export default OrbLogo;
