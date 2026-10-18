/**
 * 灵境仪表盘 · 共享层
 * 只放四个子面板共用的常量、格式化与类型，不放任何业务逻辑。
 */
import type { AgentContext } from '../../types';

export type MemoryItem = AgentContext['memories'][number];
export type ReminderItem = AgentContext['reminders'][number];

export const KIND_ICON: Record<string, string> = {
  home: '🏠', food: '🍽️', travel: '✈️', movie: '🎬', book: '📖', sport: '🏃',
  coffee: '☕', music: '🎵', work: '💼', health: '💗', other: '✦',
};
export const KIND_LABEL: Record<string, string> = {
  home: '生活', food: '饮食', travel: '出行', movie: '影音', book: '阅读', sport: '运动',
  coffee: '咖啡', music: '音乐', work: '工作', health: '健康', other: '其他',
};
export const ARTIFACT_LABEL: Record<string, string> = {
  itinerary: '行程', report: '报告', checklist: '清单', note: '笔记',
};
export const ARTIFACT_ICON: Record<string, string> = {
  itinerary: '🗺️', report: '📊', checklist: '✅', note: '📝',
};

export const fmtDate = (s?: string) => {
  if (!s) return '';
  const d = new Date(s);
  if (isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** epoch ms → `<input type="date">` 需要的 YYYY-MM-DD（本地时区） */
export const toDateInput = (ts: number | null): string => {
  if (ts === null) return '';
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** 到期展示：优先用结构化 due_ts；解析不出的原文（如「最后一天」）原样显示，不假装有时间 */
export const fmtDueLabel = (r: { due_ts: number | null; due_at: string | null }): string => {
  if (r.due_ts !== null) {
    const d = new Date(r.due_ts);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  return r.due_at || '';
};

/** 归一化记忆 key，用于「可能重复」检测（去空白/标点/大小写，复用提醒去重思路） */
export const normKey = (s: string) =>
  (s || '')
    .replace(/\s+/g, '')
    .replace(/[，。、！？,.!?~～·:：;；'"“”‘’()（）\-—_/\\]/g, '')
    .toLowerCase();

/** 展开态集合的纯函数切换（不要在 setState 里就地改原 Set） */
export const toggleSet = (set: Set<string>, id: string): Set<string> => {
  const next = new Set(set);
  next.has(id) ? next.delete(id) : next.add(id);
  return next;
};

/** 记忆是否已过期（expire_at 已过） */
export const isExpired = (m: MemoryItem) => !!m.expire_at && new Date(m.expire_at).getTime() <= Date.now();

/** 提醒是否已逾期（只认结构化 due_ts，绝不解析原文） */
export const isOverdue = (r: ReminderItem) => r.done !== 1 && r.due_ts !== null && r.due_ts < Date.now();
