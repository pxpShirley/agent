/**
 * 灵境仪表盘 · 可测的领域纯函数
 * 刻意不放 React：scripts/ 下的探针用 tsx 直接 import 这些函数做回归（见 dashboard-logic-probe.ts）。
 */
import type { AgentContext } from '../../types';
import { normKey } from './shared';

type MemoryItem = AgentContext['memories'][number];
type ReminderItem = AgentContext['reminders'][number];

/**
 * 冲突检测：跨全部记忆（不受筛选影响），归一化 key 互为前缀即视为同一主题的重复。
 * 返回 id → 同组全部 id（含自身），供「一键合并」使用。
 */
export function detectConflictGroups(memories: MemoryItem[]): Map<string, string[]> {
  const items = memories.map((m) => ({ id: m.id, k: normKey(m.key || '') }));
  const groups = new Map<string, string[]>();
  for (const a of items) {
    if (a.k.length < 4) continue;
    let base = a.k;
    for (const b of items) {
      if (b.id === a.id) continue;
      if (b.k.length >= 4 && (b.k.startsWith(a.k) || a.k.startsWith(b.k))) {
        base = b.k.length < base.length ? b.k : base;
      }
    }
    const arr = groups.get(base) || [];
    if (!arr.includes(a.id)) arr.push(a.id);
    groups.set(base, arr);
  }
  const out = new Map<string, string[]>();
  for (const g of groups.values()) {
    if (g.length > 1) for (const id of g) out.set(id, g);
  }
  return out;
}

/** 记忆筛选：类目 + 关键词（key/value 任一命中） */
export function filterMemories(memories: MemoryItem[], kind: string, q: string): MemoryItem[] {
  const kw = q.trim().toLowerCase();
  return memories.filter((m) => {
    if (kind !== 'all' && m.kind !== kind) return false;
    if (kw && !`${m.key || ''}${m.value || ''}`.toLowerCase().includes(kw)) return false;
    return true;
  });
}

/**
 * 目标进度：已完成 100%，有结构化到期就按「创建→到期」线性推进，
 * 无法判定的一律给 25%（不做随机、不做假数据）。
 */
export function goalProgress(r: ReminderItem, nowMs: number = Date.now()): number {
  if (r.done === 1) return 100;
  if (r.due_ts === null) return 25;
  const start = new Date(r.created_at).getTime();
  const end = r.due_ts;
  if (!isFinite(start) || !isFinite(end) || end <= start) return 25;
  return Math.max(8, Math.min(92, Math.round(((nowMs - start) / (end - start)) * 100)));
}
