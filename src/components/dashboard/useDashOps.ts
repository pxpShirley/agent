import { useCallback, useState } from 'react';

export interface DashOps {
  busy: boolean;
  /** 统一执行一个改动操作：置忙 → 调用 → 成功后刷新上下文 → 收尾 */
  runOp: (fn: () => Promise<unknown>, after?: () => void) => Promise<void>;
}

export interface DashOpsBag extends DashOps {
  notice: string | null;
}

/**
 * 仪表盘写操作的统一外壳：并行保护 + 失败提示 + 改动后刷新外层上下文。
 * 三个子面板共用一份 busy/notice，避免同一个面板里出现两个互相打架的「操作中」。
 */
export function useDashOps(onChanged?: () => void): DashOpsBag {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const runOp = useCallback(
    async (fn: () => Promise<unknown>, after?: () => void) => {
      if (busy) return;
      setBusy(true);
      try {
        await fn();
        after?.();
        onChanged?.();
      } catch (e: any) {
        const msg = e?.message || '操作失败';
        setNotice(msg);
        setTimeout(() => setNotice((n) => (n === msg ? null : n)), 2600);
      } finally {
        setBusy(false);
      }
    },
    [busy, onChanged],
  );

  return { busy, notice, runOp };
}
