import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import './MusicPlayer.css';

interface Track {
  id: string;
  title: string;
  artist: string | null;
  album: string | null;
}

/** 栖光指挥播放的事件桥接：服务端工具选好曲后，前端派发这个事件即可 */
export interface MusicPlayDetail {
  ids: string[];
  reason?: string;
}

const fmt = (s: number) => {
  if (!Number.isFinite(s) || s <= 0) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
};

/** 依据 id 稳定哈希出一抹色相，给每首歌生成专属渐变"封面"（本地曲无封面图，用生成式封面代替） */
const coverHue = (id: string) => {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
};
/** 有景深的封面：径向高光 + 双色线性渐变 + 内描边/暗角，读起来像真专辑封面而非色块 */
const coverStyle = (id: string): CSSProperties => {
  const h = coverHue(id);
  const h2 = (h + 26) % 360;
  return {
    background: `radial-gradient(125% 105% at 26% 16%, hsl(${h} 80% 68% / 0.95), transparent 56%), linear-gradient(150deg, hsl(${h} 58% 50%), hsl(${h2} 62% 32%))`,
    boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.20), inset 0 -34px 50px -28px rgba(0,0,0,0.5), 0 12px 26px -14px rgba(0,0,0,0.6)',
  };
};
/** 朦胧主题背景：取当前曲色相做两团柔光，模拟网易云「背景随专辑主题色变化」的氤氲氛围 */
const coverBg = (id: string): CSSProperties => {
  const h = coverHue(id);
  const h2 = (h + 30) % 360;
  return {
    background: `radial-gradient(120% 95% at 16% 12%, hsl(${h} 80% 58% / 0.9), transparent 60%), radial-gradient(95% 85% at 92% 100%, hsl(${h2} 64% 42% / 0.72), transparent 55%)`,
  };
};
/** 用 id 派生出确定性的波形高度数组（中间高、两边低的包络 + 伪随机抖动），让每首封面都不同却又"像音乐" */
const WAVE_N = 32;
const WAVE_H = 44;
const waveBars = (seed: string): number[] => {
  let h = 2166136261;
  for (const c of seed || 'x') h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  const rnd = () => {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    return ((h >>> 0) % 1000) / 1000;
  };
  const bars: number[] = [];
  for (let i = 0; i < WAVE_N; i++) {
    const env = Math.sin((i / (WAVE_N - 1)) * Math.PI); // 0→1→0 包络
    bars.push(0.16 + (0.2 + 0.8 * rnd()) * (0.35 + 0.65 * env));
  }
  return bars;
};
function CoverWave({ id }: { id: string }) {
  const bars = useMemo(() => waveBars(id), [id]);
  const n = bars.length;
  const w = (100 / n) * 0.52;
  return (
    <svg className="mp-wave" viewBox={`0 0 100 ${WAVE_H}`} preserveAspectRatio="none" aria-hidden>
      {bars.map((b, i) => {
        const bh = Math.max(2, b * (WAVE_H - 6));
        const y = (WAVE_H - bh) / 2;
        const x = (i + 0.5) * (100 / n);
        return <rect key={i} x={x - w / 2} y={y} width={w} height={bh} rx={w / 2} />;
      })}
    </svg>
  );
}

/**
 * 本地音乐播放器（M 音乐能力）
 *
 * 三条纪律：
 * 1. 音频通过 /api/music/stream/:id 流式播放，**不在前端落地、不上传**。
 * 2. 浏览器自动播放策略：非用户手势触发的 play() 会被拒绝 —— 被拒时给一个
 *    「点一下让我出声」的按钮，用真实手势解锁，而不是静默失败。
 * 3. 曲目来自后端索引，播放器只认 id，不拼接任何本地路径（防穿越）。
 *
 * 两种形态：
 * - page：独立「音乐」页面 —— 顶部「正在播放」播放器（暂停/切歌/进度/音量）+ 下方可滚曲库。
 * - 非 page（已不常用）：紧凑条 + 可折叠列表。
 */
export function MusicPlayer({ page = false, onState }: { page?: boolean; onState?: (s: { playing: boolean; title: string }) => void }) {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [visible, setVisible] = useState(false);
  const [queue, setQueue] = useState<string[]>([]);
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [expanded, setExpanded] = useState(page);
  const [q, setQ] = useState('');
  const [err, setErr] = useState('');
  const [needUnlock, setNeedUnlock] = useState(false);
  const [reason, setReason] = useState('');
  const [cur, setCur] = useState(0);
  const [dur, setDur] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const reportedRef = useRef<string>('');

  const currentId = queue[idx] || '';
  const current = tracks.find((t) => t.id === currentId) || null;

  // 初始化：只有真的索引到了曲子才出现，没配音乐目录时完全隐形
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const st = await fetch('/api/music/status').then((r) => r.json());
        if (!alive || !st.exists || !st.count) return;
        const list = await fetch('/api/music/tracks?limit=500').then((r) => r.json());
        if (!alive) return;
        const ts: Track[] = list.tracks || [];
        if (!ts.length) return;
        setTracks(ts);
        setVisible(true);
      } catch {
        /* 后端不可达时静默隐身，不打扰主界面 */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const playAt = useCallback((nextIdx: number, list: string[]) => {
    const audio = audioRef.current;
    const id = list[nextIdx];
    if (!audio || !id) return;
    setIdx(nextIdx);
    audio.src = `/api/music/stream/${id}`;
    setNeedUnlock(false);
    audio.play().catch(() => setNeedUnlock(true)); // 自动播放被拒 → 等人点一下
  }, []);

  const startQueue = useCallback(
    (ids: string[], from = 0) => {
      if (!ids.length) return;
      setQueue(ids);
      requestAnimationFrame(() => playAt(from, ids));
    },
    [playAt],
  );

  // 栖光指挥：window 上派发 xl-music 事件即可播放（服务端工具只回 id 列表）
  useEffect(() => {
    const handler = (e: Event) => {
      const d = (e as CustomEvent<MusicPlayDetail>).detail || ({} as MusicPlayDetail);
      setReason(d.reason || '');
      startQueue(d.ids || []);
      setExpanded(true);
    };
    window.addEventListener('xl-music', handler);
    return () => window.removeEventListener('xl-music', handler);
  }, [startQueue]);

  const toggle = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    // 啥都没在放：默认从曲库第一首开始
    if (!queue.length && tracks.length) {
      startQueue([tracks[0].id]);
      return;
    }
    if (!audio.src && currentId) audio.src = `/api/music/stream/${currentId}`;
    if (audio.paused) audio.play().then(() => setNeedUnlock(false)).catch(() => setNeedUnlock(true));
    else audio.pause();
  }, [queue.length, tracks, startQueue, currentId]);

  const step = useCallback(
    (delta: number) => {
      if (!queue.length) return;
      const n = (idx + delta + queue.length) % queue.length;
      playAt(n, queue);
    },
    [idx, queue, playAt],
  );

  const seek = useCallback((value: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = value;
    setCur(value);
  }, []);

  // 栖光指挥：暂停 / 继续 / 切歌 / 音量（必须放在 step 之后声明，否则闭包引用不到）
  useEffect(() => {
    const handler = (e: Event) => {
      const d = (e as CustomEvent<{ action?: string; value?: number }>).detail || {};
      const audio = audioRef.current;
      if (!audio || !d.action) return;
      if (d.action === 'pause') audio.pause();
      else if (d.action === 'resume') audio.play().catch(() => setNeedUnlock(true));
      else if (d.action === 'next') step(1);
      else if (d.action === 'prev') step(-1);
      else if (d.action === 'volume' && typeof d.value === 'number') {
        audio.volume = Math.max(0, Math.min(1, d.value));
      }
    };
    window.addEventListener('xl-music-control', handler);
    return () => window.removeEventListener('xl-music-control', handler);
  }, [step]);

  // 把"是否正在播放 + 当前曲名"上报给外壳，使导航栏的「音乐」按钮能显示播放态
  useEffect(() => {
    onState?.({ playing, title: current?.title || '' });
  }, [playing, current, onState]);

  const filtered = q.trim() ? tracks.filter((t) => `${t.title}${t.artist || ''}${t.album || ''}`.toLowerCase().includes(q.trim().toLowerCase())) : tracks;
  const seekPct = dur > 0 ? Math.min(100, (cur / dur) * 100) : 0;

  if (!visible) return null;

  return (
    <div className={`mp${expanded ? ' open' : ''}${page ? ' mp-page' : ''}`}>
      {/* 页面模式：顶部「正在播放」播放器 —— 暂停 / 切歌 / 进度 / 音量 都在这 */}
      {page && (
        <div className="mp-now">
          <div className="mp-now-bg" style={current ? coverBg(current.id) : undefined} aria-hidden />
          <div className={`mp-vinyl${playing ? ' on' : ''}`} aria-hidden>
            <div className="mp-vinyl-label" style={current ? coverStyle(current.id) : undefined}>
              <CoverWave id={current?.id || 'x'} />
            </div>
            <span className="mp-vinyl-hole" />
          </div>
          <div className="mp-now-body">
            <div className="mp-now-title">
              {current ? current.title : '选一首开始播放'}
              {reason ? <em className="mp-why">{reason}</em> : null}
            </div>
            <div className="mp-now-artist">
              <span className={`mp-wave-mini${playing ? ' on' : ''}`} aria-hidden><i /><i /><i /><i /></span>
              {current?.artist || (tracks.length ? '本地曲库' : '未配置音乐目录')}
            </div>
            <div className="mp-now-ctrl">
              <button className="mp-btn" onClick={() => step(-1)} aria-label="上一首" disabled={!queue.length}>‹‹</button>
              <button className="mp-btn play big" onClick={toggle} aria-label={playing ? '暂停' : '播放'}>
                {playing ? '❙❙' : '▶'}
              </button>
              <button className="mp-btn" onClick={() => step(1)} aria-label="下一首" disabled={!queue.length}>››</button>
              <span className="mp-now-time">{fmt(cur)} / {fmt(dur)}</span>
            </div>
            <input
              className="mp-seek"
              type="range"
              min={0}
              max={dur || 0}
              step={0.5}
              value={Math.min(cur, dur || 0)}
              onChange={(e) => seek(Number(e.target.value))}
              aria-label="播放进度"
              style={{ background: `linear-gradient(to right, var(--core, #6fd6ff) ${seekPct}%, rgba(140, 170, 220, 0.16) ${seekPct}%)` }}
            />
            <div className="mp-now-foot">
              <svg className="mp-now-vol" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M4 9v6h4l5 4V5L8 9H4z" /><path d="M16 9a3 3 0 0 1 0 6" />
              </svg>
              <input
                className="mp-vol"
                type="range"
                min={0}
                max={1}
                step={0.05}
                defaultValue={0.8}
                aria-label="音量"
                onChange={(e) => {
                  if (audioRef.current) audioRef.current.volume = Number(e.target.value);
                }}
              />
              {needUnlock && (
                <button className="mp-unlock" onClick={toggle}>
                  点一下让我出声
                </button>
              )}
              {err ? <span className="mp-err">{err}</span> : null}
            </div>
          </div>
        </div>
      )}

      {expanded && (
        <div className="mp-panel">
          <div className="mp-panel-h">
            <span>音乐</span>
            {reason ? <span className="mp-reason">{reason}</span> : null}
            {!page && (
              <button className="mp-x" onClick={() => setExpanded(false)} aria-label="收起">
                ✕
              </button>
            )}
          </div>
          <div className="mp-hint-row">对栖光说「放首歌」「来点周杰伦」即可播放</div>
          <input
            className="mp-search"
            value={q}
            placeholder="搜歌名 / 歌手"
            onChange={(e) => setQ(e.target.value)}
          />
          <div className="mp-grid">
            {filtered.map((t) => {
              const ids = filtered.map((x) => x.id);
              const i = ids.indexOf(t.id);
              const on = t.id === currentId;
              return (
                <button
                  key={t.id}
                  className={`mp-card${on ? ' on' : ''}${on && playing ? ' playing' : ''}`}
                  onClick={() => startQueue(ids, i < 0 ? 0 : i)}
                >
                  <div className="mp-card-cover" style={coverStyle(t.id)}>
                    <CoverWave id={t.id} />
                    <span className="mp-card-play" aria-hidden>{on && playing ? '❙❙' : '▶'}</span>
                  </div>
                  <div className="mp-card-meta">
                    <div className="mp-card-title">{t.title}</div>
                    <div className="mp-card-artist">{t.artist || '未知歌手'}</div>
                  </div>
                </button>
              );
            })}
            {!filtered.length && <div className="mp-empty">没找到，试试别的关键词</div>}
          </div>
        </div>
      )}

      {/* 非页面模式：紧凑传输条（现已少用，保留兼容） */}
      {!page && (
        <div className="mp-bar">
          <button className="mp-btn" onClick={() => step(-1)} aria-label="上一首" disabled={!queue.length}>‹‹</button>
          <button className="mp-btn play" onClick={toggle} aria-label={playing ? '暂停' : '播放'}>
            {playing ? '❙❙' : '▶'}
          </button>
          <button className="mp-btn" onClick={() => step(1)} aria-label="下一首" disabled={!queue.length}>››</button>
          <button className="mp-title" onClick={() => setExpanded((v) => !v)} title={current ? current.title : '选一首'}>
            {current ? (
              <>
                <b>{current.title}</b>
                <span>{current.artist || '未知歌手'}</span>
              </>
            ) : (
              <span className="mp-hint">点这里选一首</span>
            )}
            {reason && !expanded ? <em className="mp-why">{reason}</em> : null}
          </button>
          {needUnlock ? (
            <button className="mp-unlock" onClick={toggle}>点一下让我出声</button>
          ) : null}
          {err ? <span className="mp-err">{err}</span> : null}
          <input
            className="mp-vol"
            type="range"
            min={0}
            max={1}
            step={0.05}
            defaultValue={0.8}
            aria-label="音量"
            onChange={(e) => {
              if (audioRef.current) audioRef.current.volume = Number(e.target.value);
            }}
          />
        </div>
      )}

      <audio
        ref={audioRef}
        preload="metadata"
        onPlay={() => {
          setPlaying(true);
          if (currentId && reportedRef.current !== currentId) {
            reportedRef.current = currentId;
            fetch('/api/music/played', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ id: currentId }),
            }).catch(() => {});
          }
        }}
        onPause={() => setPlaying(false)}
        onTimeUpdate={(e) => setCur(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setDur(e.currentTarget.duration || 0)}
        onEnded={() => step(1)}
        onError={() => {
          setErr('这首放不出来');
          setPlaying(false);
        }}
      />
    </div>
  );
}
