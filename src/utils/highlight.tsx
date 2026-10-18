import type { ReactNode } from 'react';

/**
 * 搜索命中高亮：把命中的关键词包成 <mark>，其余原样输出。
 * 历史会话列表 / ⌘K 命令面板共用，避免两处各写一份。
 */
export function highlightNodes(text: string, keyword: string): ReactNode[] {
  const t = text || '';
  const k = (keyword || '').trim();
  if (!k) return [t];
  const lower = t.toLowerCase();
  const target = k.toLowerCase();
  const parts: ReactNode[] = [];
  let i = 0;
  let idx = lower.indexOf(target);
  let n = 0;
  while (idx !== -1 && n < 50) {
    if (idx > i) parts.push(t.slice(i, idx));
    parts.push(
      <mark className="hx-mark" key={`${idx}-${n}`}>
        {t.slice(idx, idx + k.length)}
      </mark>,
    );
    i = idx + k.length;
    idx = lower.indexOf(target, i);
    n++;
  }
  if (i < t.length) parts.push(t.slice(i));
  return parts;
}
