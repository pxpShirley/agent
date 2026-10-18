import { useEffect, useRef, useState } from 'react';
import type { XinglanMood } from './StarSprite';
import { StarSprite } from './StarSprite';

export type CoreState = 'idle' | 'thinking' | 'speaking' | 'listening';
export type AgentPhase = 'idle' | 'active' | 'done';

const NODES: { key: string; cls: string; label: string; verb: string }[] = [
  { key: 'planner', cls: 'n-planner', label: '规划', verb: '规划中' },
  { key: 'researcher', cls: 'n-researcher', label: '研究', verb: '检索中' },
  { key: 'executor', cls: 'n-executor', label: '执行', verb: '执行中' },
  { key: 'critic', cls: 'n-critic', label: '复核', verb: '复核中' },
];

/** 星轨节点角度（y-down 度数，0=右，90=下）。非对称分布，避开正四角，顺时针流转 */
const ORB_ANGLES = [238, 325, 55, 142];

const STATE_LABEL: Record<CoreState, string> = {
  idle: '静候',
  thinking: '思考中',
  speaking: '诉说中',
  listening: '聆听中',
};

function moodColor(state: CoreState, attention: boolean, accent?: 'nebula' | 'warm', mood?: XinglanMood): string {
  const warm = accent === 'warm';
  // 安睡：整体收暗，让"闭眼"看起来是休息而不是故障
  if (mood === 'sleeping') return warm ? 'rgba(255,200,120,0.26)' : 'rgba(94,242,255,0.24)';
  if (attention) return warm ? 'rgba(255,180,90,0.6)' : 'rgba(255,207,107,0.55)';
  if (state === 'thinking') return warm ? 'rgba(255,180,90,0.6)' : 'rgba(111,214,255,0.5)';
  if (state === 'speaking') return warm ? 'rgba(255,200,120,0.6)' : 'rgba(94,242,255,0.55)';
  if (state === 'listening') return warm ? 'rgba(255,170,100,0.55)' : 'rgba(111,214,255,0.46)';
  return warm ? 'rgba(255,200,120,0.46)' : 'rgba(94,242,255,0.42)';
}

interface Props {
  state?: CoreState;
  energy?: number;
  attention?: boolean;
  agentPhase?: Partial<Record<string, AgentPhase>>;
  agentDetail?: Partial<Record<string, string>>;
  accent?: 'nebula' | 'warm';
  mood?: XinglanMood;
  /** 状态文案覆写（跟随情绪，而非机械的 静候/思考中） */
  stateLabel?: string;
  caption?: string;
  waiting?: boolean;
  onCoreClick?: () => void;
}

/**
 * 星核伴生体 v3：执行链由「四角圆球 + mesh 连线」重构为「环绕栖光的椭圆星轨」。
 * - 基环（虚线椭圆）常驻，给舞台结构感
 * - 4 个轨道光点按非对称角度分布；步骤激活时「到达弧」沿顺时针循序流光点亮
 * - 光点激活 = 发光 + 放大 + 扩散脉冲环；标签胶囊随亮起变青
 * - 几何随容器尺寸响应式重算（layoutOrbit），相位变化同步点亮态（syncSeg）
 * - 核心为拟人精灵 StarSprite：有脸有表情，眼睛跟随鼠标，mood 驱动情绪表达
 *   （曾于 09-28 短暂替换为无脸光体 XinglanLight，按用户要求已换回拟人形象）
 * - XinglanLight 组件保留未删除，如需对比可直接换回
 */
export function XinglanCore({
  state = 'idle',
  energy = 0,
  attention = false,
  agentPhase = {},
  agentDetail = {},
  accent = 'nebula',
  mood,
  stateLabel,
  caption,
  waiting = false,
  onCoreClick,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [ponder, setPonder] = useState(false);
  const [ping, setPing] = useState(false);

  // 有机呼吸：rAF 写 --breath，避免每帧 React 重渲染；标签页隐藏时暂停以省 CPU
  useEffect(() => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const wrap = wrapRef.current;
    if (!wrap) return;
    if (reduce) { wrap.style.setProperty('--breath', '0.5'); return; }
    let raf = 0;
    let paused = false;
    const t0 = performance.now();
    const loop = (now: number) => {
      if (paused) return;
      const t = (now - t0) / 1000;
      const b = 0.5 + 0.5 * (0.62 * Math.sin(t * 0.9) + 0.38 * Math.sin(t * 0.37 + 1.3));
      wrap.style.setProperty('--breath', b.toFixed(4));
      raf = requestAnimationFrame(loop);
    };
    const onVisibility = () => {
      if (document.hidden) {
        paused = true;
        cancelAnimationFrame(raf);
      } else if (paused) {
        paused = false;
        loop(performance.now());
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    raf = requestAnimationFrame(loop);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      cancelAnimationFrame(raf);
    };
  }, []);

  // 空闲走神涟漪
  useEffect(() => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) return;
    let timer: number;
    const schedule = () => {
      const delay = 9000 + Math.random() * 6000;
      timer = window.setTimeout(() => {
        if (state === 'idle') { setPonder(true); window.setTimeout(() => setPonder(false), 1900); }
        schedule();
      }, delay);
    };
    schedule();
    return () => window.clearTimeout(timer);
  }, [state]);

  // 星轨几何：mount + resize 重算（基环、节点位置、弧线 d），随后同步点亮态
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const layout = () => {
      const w = wrap.clientWidth;
      const h = wrap.clientHeight;
      if (w < 10 || h < 10) return;
      const cx = w / 2;
      const cy = h * 0.44;
      const rx = Math.min(w * 0.4, 260);
      const ry = Math.min(h * 0.32, 150);
      const base = wrap.querySelector('#xc-orbit-base') as SVGEllipseElement | null;
      if (base) { base.setAttribute('cx', String(cx)); base.setAttribute('cy', String(cy)); base.setAttribute('rx', String(rx)); base.setAttribute('ry', String(ry)); }
      const pts: [number, number][] = [];
      for (let i = 0; i < 4; i++) {
        const rad = (ORB_ANGLES[i] * Math.PI) / 180;
        const x = cx + rx * Math.cos(rad);
        const y = cy + ry * Math.sin(rad);
        pts.push([x, y]);
        const n = wrap.querySelector(`#xc-orb${i}`) as HTMLElement | null;
        if (n) { n.style.left = `${x}px`; n.style.top = `${y}px`; n.classList.toggle('up', Math.sin(rad) < 0); }
      }
      for (let s = 0; s < 4; s++) {
        const a = pts[s];
        const b = pts[(s + 1) % 4];
        const seg = wrap.querySelector(`#xc-oseg${s}`) as SVGPathElement | null;
        if (seg) {
          seg.setAttribute('d', `M ${a[0].toFixed(1)} ${a[1].toFixed(1)} A ${rx} ${ry} 0 0 1 ${b[0].toFixed(1)} ${b[1].toFixed(1)}`);
          seg.setAttribute('pathLength', '1');
        }
      }
      syncSeg();
    };
    const syncSeg = () => {
      const on = (i: number) => (agentPhase[NODES[i].key] || 'idle') !== 'idle';
      for (let i = 0; i < 4; i++) {
        const n = wrap.querySelector(`#xc-orb${i}`);
        if (n) n.classList.toggle('on', on(i));
        const segIdx = i - 1;
        if (segIdx >= 0) {
          const seg = wrap.querySelector(`#xc-oseg${segIdx}`) as SVGPathElement | null;
          if (seg) seg.style.strokeDashoffset = on(i) && on(i - 1) ? '0' : '1';
        }
      }
    };
    layout();
    const ro = new ResizeObserver(layout);
    ro.observe(wrap);
    window.addEventListener('resize', layout);
    return () => { ro.disconnect(); window.removeEventListener('resize', layout); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 相位变化 → 同步点亮态（几何不变，仅 dashoffset / class）
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const on = (i: number) => (agentPhase[NODES[i].key] || 'idle') !== 'idle';
    for (let i = 0; i < 4; i++) {
      const n = wrap.querySelector(`#xc-orb${i}`);
      if (n) n.classList.toggle('on', on(i));
      if (i > 0) {
        const seg = wrap.querySelector(`#xc-oseg${i - 1}`) as SVGPathElement | null;
        if (seg) seg.style.strokeDashoffset = on(i) && on(i - 1) ? '0' : '1';
      }
    }
  }, [agentPhase]);

  const handleCoreClick = () => {
    setPing(true);
    window.setTimeout(() => setPing(false), 720);
    onCoreClick?.();
  };

  const phaseOf = (k: string): AgentPhase => agentPhase[k] || 'idle';
  const activeNode = NODES.find((n) => phaseOf(n.key) === 'active');

  return (
    <div
      className={`xc-wrap ${energy >= 0.5 ? 'xc-energy' : ''} ${waiting ? 'xc-waiting' : ''}`}
      ref={wrapRef}
      data-mood={mood || 'calm'}
      style={
        {
          ['--energy' as string]: energy,
          ['--mood' as string]: moodColor(state, attention, accent, mood),
        } as React.CSSProperties
      }
    >
      {/* 星轨：基环 + 流光弧线 + 轨道光点（取代旧 mesh 连线 + 四角圆球） */}
      <div className="xc-orbit-wrap" aria-hidden>
        <svg className="xc-orbit-svg">
          <defs>
            <linearGradient id="xc-oseg" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#5fe1ff" stopOpacity="0.95" />
              <stop offset="100%" stopColor="#7af0d4" stopOpacity="0.95" />
            </linearGradient>
          </defs>
          <ellipse className="xc-o-base" id="xc-orbit-base" />
          <path className="xc-o-seg" id="xc-oseg0" />
          <path className="xc-o-seg" id="xc-oseg1" />
          <path className="xc-o-seg" id="xc-oseg2" />
          <path className="xc-o-seg" id="xc-oseg3" />
        </svg>
        {NODES.map((n, i) => (
          <div className="xc-orb" id={`xc-orb${i}`} key={n.key}>
            <span className="xc-orb-lab">{n.label}</span>
            <span className="xc-orb-dot" />
          </div>
        ))}
      </div>

      <div className="xc-aura" aria-hidden />
      <div className={`xc-ripple ${ponder ? 'on' : ''}`} aria-hidden />

      <div
        className={`xc-core has-sprite ${state === 'thinking' ? 'thinking' : ''} ${ping ? 'ping' : ''}`}
        onClick={handleCoreClick}
        role="img"
        aria-label={`栖光，${stateLabel || STATE_LABEL[state]}`}
      >
        <StarSprite
          accent={accent}
          waiting={waiting}
          speaking={state === 'speaking'}
          mood={mood}
        />
      </div>

      <div className="xc-state">
        栖光 · <b>{stateLabel || STATE_LABEL[state]}</b>
        {activeNode && <span className="xc-actnow"> · {agentDetail[activeNode.key] || activeNode.verb}</span>}
      </div>
      {caption && <div className="xc-caption">{caption}</div>}
    </div>
  );
}
