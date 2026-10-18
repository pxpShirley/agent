import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 「贴底跟随」滚动 —— 聊天流的标准解法。
 *
 * 背景：以前是 `useEffect(() => scrollTo(底部), [messages])`，没有任何前提判断。
 * 后果是流式输出时每个 token 都把视图拽到底部——用户想往上翻看刚才那句，
 * 手一松就被拉回去，等于**看历史的权利被剥夺了**。
 *
 * 正解：跟随是**有条件**的——只有当用户本来就贴着底部时才自动跟随；
 * 用户一旦主动往上翻，就停止跟随，改为显示「回到最新」，把控制权还给用户。
 *
 * @param dep    触发跟随的依赖（通常是 messages）。变化时不贴底则不动。
 * @param threshold 距底部多少 px 内算「贴底」
 */
/**
 * 「是否贴底」的判定，单独导出以便回归测试（hook 依赖 React 运行时，node 里跑不了）。
 * 阈值给的是容差：流式输出 + 平滑滚动会有几像素误差，判等会抖。
 */
export function isAtBottom(
  el: { scrollHeight: number; scrollTop: number; clientHeight: number },
  threshold = 56,
): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
}

export function useStickToBottom<T extends HTMLElement>(dep: unknown, threshold = 56) {
  const ref = useRef<T | null>(null);
  const [pinned, setPinned] = useState(true);
  /** 镜像一份给 effect 读：setPinned 是异步的，effect 里读 state 会拿到旧值 */
  const pinnedRef = useRef(true);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      const p = isAtBottom(el, threshold);
      pinnedRef.current = p;
      setPinned(p);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [threshold]);

  useEffect(() => {
    if (!pinnedRef.current) return;
    const el = ref.current;
    if (!el) return;
    // 跟随用瞬时滚动：流式输出每帧都触发，smooth 会排队累积、越跟越慢
    el.scrollTop = el.scrollHeight;
  }, [dep]);

  /** 手动回到底部（用户点「回到最新」） */
  const stick = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    pinnedRef.current = true;
    setPinned(true);
  }, []);

  return { ref, pinned, stick };
}
