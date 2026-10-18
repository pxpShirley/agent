import { useMemo, useState } from 'react';
import type { SessionSummary } from '../types';
import { IntentBadge, StatusBadge } from './Badges';
import { relativeTime } from '../utils/format';
import { highlightNodes } from '../utils/highlight';

interface Props {
  sessions: SessionSummary[];
  currentId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onNew: () => void;
}

// 按 updated_at 归桶：今天 / 昨天 / 本周 / 更早
function dateBucket(iso?: string): 'today' | 'yesterday' | 'week' | 'older' {
  if (!iso) return 'older';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return 'older';
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const t = d.getTime();
  if (t >= startOfToday) return 'today';
  if (t >= startOfToday - 86_400_000) return 'yesterday';
  if (t >= startOfToday - 7 * 86_400_000) return 'week';
  return 'older';
}

const BUCKET_LABEL: Record<'today' | 'yesterday' | 'week' | 'older', string> = {
  today: '今天',
  yesterday: '昨天',
  week: '本周',
  older: '更早',
};
const BUCKET_ORDER: (keyof typeof BUCKET_LABEL)[] = ['today', 'yesterday', 'week', 'older'];

const highlight = highlightNodes;

export function SessionList({ sessions, currentId, onSelect, onDelete, onNew }: Props) {
  const [q, setQ] = useState('');

  const grouped = useMemo(() => {
    const kw = q.trim().toLowerCase();
    const filtered = !kw
      ? sessions
      : sessions.filter((s) => `${s.title || ''}${s.lastMessage || ''}`.toLowerCase().includes(kw));
    const map: Record<string, SessionSummary[]> = {};
    for (const s of filtered) {
      const b = dateBucket(s.updated_at);
      (map[b] ||= []).push(s);
    }
    // 组内按更新时间倒序
    for (const k of Object.keys(map)) map[k].sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
    return BUCKET_ORDER.filter((b) => map[b]?.length).map((b) => ({ key: b, items: map[b] }));
  }, [sessions, q]);

  const total = sessions.length;
  const shown = grouped.reduce((n, g) => n + g.items.length, 0);
  const kw = q.trim();

  return (
    <div className="hx-root">
      {/* 新建入口在外层侧视图标题行（nx-new-chat-btn），此处不再重复 */}

      <div className="nx-hist-toolbar">
        <input
          className="nx-hist-search"
          type="search"
          placeholder="搜对话标题或内容"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="搜索历史对话"
        />
        <div className="nx-hist-count">{shown === total ? `${total} 段` : `${shown}/${total} 段`}</div>
      </div>

      <div className="hx-scroll">
        {total === 0 && (
          <div className="xl-drawer-empty">
            <div className="de-ico">✦</div>
            <div className="de-title">这里会记住每次对话</div>
            <div className="de-hint">和栖光聊完第一段后，这里会出现你和他所有的故事。</div>
            <button className="de-cta" type="button" onClick={onNew}>
              开始第一段对话
            </button>
          </div>
        )}

        {total > 0 && shown === 0 && (
          <div className="xl-drawer-empty">
            <div className="de-ico">🔍</div>
            <div className="de-title">没有匹配的对话</div>
            <div className="de-hint">换个关键词试试。</div>
          </div>
        )}

        {grouped.map((g) => (
          <div className="nx-hist-group" key={g.key}>
            <div className="nx-hist-group-h">{BUCKET_LABEL[g.key]} · {g.items.length}</div>
            <div className="hx-list">
              {g.items.map((s) => (
                <div
                  key={s.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelect(s.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onSelect(s.id);
                    }
                  }}
                  className={`session-item hx-card ${currentId === s.id ? 'is-active' : ''}`}
                  aria-current={currentId === s.id ? 'true' : undefined}
                >
                  <div className="hx-top">
                    <span className="hx-title">{highlight(s.title || '新的对话', kw)}</span>
                    <button
                      className="del-btn"
                      title="删除会话"
                      aria-label={`删除会话：${s.title || '新的对话'}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onDelete(s.id);
                      }}
                    >
                      ×
                    </button>
                  </div>
                  {s.lastMessage && (
                    <div className="session-preview">{highlight(s.lastMessage, kw)}</div>
                  )}
                  <div className="hx-meta">
                    <span className="hx-tags">
                      <IntentBadge intent={s.intent} />
                      <StatusBadge status={s.status} />
                    </span>
                    <span className="hx-meta-right">
                      <span>{s.messageCount ?? 0} 条</span>
                      <span className="hx-dot" aria-hidden />
                      <span>{relativeTime(s.updated_at)}</span>
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
