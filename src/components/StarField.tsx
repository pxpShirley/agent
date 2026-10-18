import { useEffect, useRef } from 'react';

interface Star {
  x: number;
  y: number;
  r: number;
  a: number;
  s: number; // 纵向漂移速度
  sway: number; // 横向摆动相位
  depth: number; // 0(远)~1(近)，影响亮度/速度
}

/**
 * 星云背景 v2：canvas 星空（多层视差 + 邻近星座连线）+ 三团 CSS 星云辉光 + 边缘暗角。
 * - 3 个深度层：越近越大越亮、漂移越快，制造纵深
 * - 最近层邻近星点之间偶尔连出 faint 星座线，空间更"活"
 * - 尊重 prefers-reduced-motion（静止渲染一帧）
 * - 性能：标签页隐藏时暂停 rAF；星座连线合并为单次 Path2D 描边（避免每帧 O(n²) 次 beginPath/stroke）
 */
export function StarField({ lite = false, accent = 'nebula' }: { lite?: boolean; accent?: 'nebula' | 'warm' }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // 配色随主题：极光(青紫) / 暖光(暖金)
    const pal =
      accent === 'warm'
        ? { near: '255,216,170', far: '240,192,150', link: '255,182,120' }
        : { near: '190,215,255', far: '160,180,240', link: '150,175,255' };

    let stars: Star[] = [];
    let nearStars: Star[] = []; // 近层（用于星座连线），resize 时一次性算好，避免每帧 filter 分配
    let raf = 0;
    let paused = false;
    let t0 = performance.now();
    // 视口尺寸用 CSS 像素；canvas 背板按 devicePixelRatio 放大后由 ctx 缩放，
    // 这样星点坐标仍是 CSS 像素（高清屏不糊），且不受 dpr 影响。
    const dpr = Math.min(window.devicePixelRatio || 1, 2); // 封顶 2，避免 3x 手机背板过大掉帧
    let vw = window.innerWidth;
    let vh = window.innerHeight;

    const resize = () => {
      vw = window.innerWidth;
      vh = window.innerHeight;
      canvas.width = Math.floor(vw * dpr);
      canvas.height = Math.floor(vh * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // 必须在设完 width/height 之后（设尺寸会重置 transform）
      const cap = lite ? 120 : 360;
      const total = Math.min(cap, Math.floor((vw * vh) / (lite ? 16000 : 5600)));
      stars = Array.from({ length: total }, () => {
        const depth = Math.random();
        return {
          x: Math.random() * vw,
          y: Math.random() * vh,
          r: 0.3 + depth * 1.7,
          a: 0.18 + depth * 0.6,
          s: (0.006 + depth * 0.03) * (Math.random() > 0.5 ? 1 : 0.6),
          sway: Math.random() * Math.PI * 2,
          depth,
        };
      });
      nearStars = stars.filter((s) => s.depth > 0.62);
    };
    resize();
    window.addEventListener('resize', resize);

    // 星座连线：合并进一条 Path2D，单次 stroke（原实现每对星点各自 beginPath/stroke，O(n²) 次绘制调用）
    const drawLinks = (maxDist: number) => {
      if (nearStars.length < 2) return;
      const path = new Path2D();
      for (let i = 0; i < nearStars.length; i++) {
        for (let j = i + 1; j < nearStars.length; j++) {
          const dx = nearStars[i].x - nearStars[j].x;
          const dy = nearStars[i].y - nearStars[j].y;
          const d = Math.hypot(dx, dy);
          if (d < maxDist) {
            path.moveTo(nearStars[i].x, nearStars[i].y);
            path.lineTo(nearStars[j].x, nearStars[j].y);
          }
        }
      }
      ctx.strokeStyle = `rgba(${pal.link},0.12)`;
      ctx.lineWidth = 0.6;
      ctx.stroke(path);
    };

    const render = (t: number) => {
      if (!ctx) return;
      ctx.clearRect(0, 0, vw, vh); // 用 CSS 像素清屏（transform 已按 dpr 放大，铺满背板）
      for (const p of stars) {
        if (!reduce) {
          p.y -= p.s;
          p.x += Math.sin(t * 0.0004 + p.sway) * 0.12 * p.depth;
          if (p.y < -2) {
            p.y = vh + 2;
            p.x = Math.random() * vw;
          }
        }
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${p.depth > 0.6 ? pal.near : pal.far},${p.a})`;
        ctx.fill();
      }
      if (!reduce && !lite && nearStars.length > 1) drawLinks(96);
    };

    const loop = () => {
      if (paused) return;
      render(performance.now());
      raf = requestAnimationFrame(loop);
    };

    const onVisibility = () => {
      if (document.hidden) {
        paused = true;
        cancelAnimationFrame(raf);
      } else if (paused) {
        paused = false;
        loop();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    if (reduce) {
      render(t0); // 静止一帧
    } else {
      loop();
    }

    return () => {
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', onVisibility);
      cancelAnimationFrame(raf);
    };
  }, [accent, lite]);

  return (
    <>
      <div className="nebula-bg" aria-hidden>
        <div className="neb-blob b1" />
        <div className="neb-blob b2" />
        <div className="neb-blob b3" />
      </div>
      <div className="neb-vignette" aria-hidden />
      <canvas id="starfield" ref={canvasRef} aria-hidden />
    </>
  );
}
