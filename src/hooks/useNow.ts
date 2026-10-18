import { useEffect, useState } from 'react';

/**
 * 会走的「现在」。
 *
 * 背景：`MomentBar` 曾在渲染时直接 `new Date()` 算一次就不动了——
 * 一个标榜「此刻 20:08」的感知条，永远停在打开页面那一刻，是肉眼可见的错。
 *
 * 刷新间隔取 15s 而不是 60s：用 setInterval 而不是「对齐到整分」的 setTimeout，
 * 是因为后者在系统休眠/后台节流后会漂移且不好恢复；15s 轮询的显示误差 ≤15s，
 * 对分钟级展示无感，但换来的是任何休眠恢复场景下都能自愈。
 */
export function useNow(intervalMs = 15_000): Date {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), intervalMs);
    // 从后台切回前台时立刻补一次，避免刚唤醒那几秒显示旧时间
    const onWake = () => setNow(new Date());
    document.addEventListener('visibilitychange', onWake);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onWake);
    };
  }, [intervalMs]);

  return now;
}
