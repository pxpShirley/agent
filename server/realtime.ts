/**
 * 星澜 · 轻量实时变更广播
 * 指挥舱（Command Deck）用它把「活动流 / 收件箱 / 记忆 / 主动卡片」从 15s 轮询
 * 升级为接近实时的推送：后端在相关数据变更时调用 notifyChanged()，
 * /api/admin/stream 的 SSE 连接会把变更推给前端，前端收到后重新拉取最新数据。
 *
 * 设计取舍：SSE 仅作为「有变更，请重新拉取」的信号（ping 模式），
 * 不承载具体 payload——复用既有 admin 拉取接口，避免序列化重复与状态漂移。
 */
type Listener = () => void;

const listeners = new Set<Listener>();

/** 订阅变更；返回取消订阅函数 */
export function subscribeChange(cb: Listener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** 广播一次「数据已变更」信号（调用方需保证数据已落库） */
export function notifyChanged(): void {
  listeners.forEach((cb) => {
    try {
      cb();
    } catch {
      /* 单个订阅者异常不影响其他订阅者 */
    }
  });
}
