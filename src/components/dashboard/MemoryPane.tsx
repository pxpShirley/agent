import { useMemo, useState } from 'react';
import { api } from '../../api';
import {
  KIND_ICON,
  KIND_LABEL,
  fmtDate,
  isExpired,
  toggleSet,
  type MemoryItem,
} from './shared';
import type { DashOps } from './useDashOps';
import { detectConflictGroups, filterMemories } from './logic';

interface Props {
  memories: MemoryItem[];
  onSend: (text: string) => void;
  ops: DashOps;
}

/** 记忆面板：类目筛选 / 搜索 / 展开 / 编辑 / 删除 / 过期清理 / 重复合并 */
export function MemoryPane({ memories, onSend, ops }: Props) {
  const { busy, runOp } = ops;
  const [kind, setKind] = useState<string>('all');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [editId, setEditId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ kind: string; key: string; value: string; expire_at: string }>({
    kind: 'other', key: '', value: '', expire_at: '',
  });

  const kinds = useMemo(() => Array.from(new Set(memories.map((m) => m.kind))), [memories]);
  const filtered = useMemo(() => filterMemories(memories, kind, q), [memories, kind, q]);
  const conflictGroups = useMemo(() => detectConflictGroups(memories), [memories]);
  // 不过 memo：过期是相对「现在」的，缓存会让它停在打开面板那一刻
  const expiredCount = memories.filter(isExpired).length;

  const startEdit = (m: MemoryItem) => {
    setEditId(m.id);
    setConfirmId(null);
    setDraft({
      kind: m.kind || 'other',
      key: m.key || '',
      value: m.value || '',
      expire_at: m.expire_at ? m.expire_at.slice(0, 10) : '',
    });
  };
  const saveEdit = (id: string) =>
    runOp(async () => {
      const expire_at = draft.expire_at ? new Date(draft.expire_at).toISOString() : null;
      await api.updateMemory(id, { kind: draft.kind, key: draft.key, value: draft.value, expire_at });
      setEditId(null);
    });
  const cleanupExpired = () => runOp(async () => { await api.cleanupMemories(); });
  /** 一键合并重复：保留信息最完整的一条，删除同组其余 */
  const mergeGroup = (ids: string[]) =>
    runOp(async () => {
      await api.mergeMemories(ids);
      setEditId(null);
      setConfirmId(null);
    });

  return (
    <div className="dash-pane">
      <div className="dash-toolbar">
        <input
          className="dash-search"
          type="search"
          placeholder="搜记忆内容"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="搜索记忆"
        />
        <div className="dash-chips">
          <button type="button" className={`dash-chip ${kind === 'all' ? 'active' : ''}`} onClick={() => setKind('all')}>全部</button>
          {kinds.map((k) => (
            <button key={k} type="button" className={`dash-chip ${kind === k ? 'active' : ''}`} onClick={() => setKind(k)}>
              {KIND_LABEL[k] ?? k}
            </button>
          ))}
        </div>
      </div>

      {expiredCount > 0 && (
        <button type="button" className="dash-cleanup" onClick={cleanupExpired} disabled={busy}>
          清理 {expiredCount} 条过期记忆
        </button>
      )}

      {filtered.length === 0 && (
        <div className="dash-empty">
          <span className="dash-empty-ico">🧠</span>
          <div className="dash-empty-title">{memories.length === 0 ? '还没有记忆' : '没有匹配的记忆'}</div>
          <div className="dash-empty-hint">{memories.length === 0 ? '和栖光多聊聊，他会慢慢记住你的偏好、习惯与关心的人。' : '换个关键词或类目试试。'}</div>
        </div>
      )}
      {filtered.slice(0, 40).map((m) => {
        const opened = open.has(m.id);
        const expired = isExpired(m);
        const group = conflictGroups.get(m.id) || [];
        const conflict = group.length > 1;
        const editing = editId === m.id;
        const confirming = confirmId === m.id;
        return (
          <div className={`panel-card ${conflict ? 'is-conflict' : ''} ${expired ? 'is-expired' : ''}`} key={m.id}>
            <div className="icon-wrap" aria-hidden><span className="icon">{KIND_ICON[m.kind] ?? '✦'}</span></div>
            {editing ? (
              <div className="dash-edit-form">
                <div className="dash-edit-row">
                  <span className="dash-edit-label">类目</span>
                  <select
                    className="dash-edit-select"
                    style={{ width: 'auto' }}
                    value={draft.kind}
                    onChange={(e) => setDraft((d) => ({ ...d, kind: e.target.value }))}
                  >
                    {Object.entries(KIND_LABEL).map(([k, label]) => (
                      <option key={k} value={k}>{label}</option>
                    ))}
                  </select>
                  <span className="dash-edit-label">过期</span>
                  <input
                    className="dash-edit-input"
                    type="date"
                    style={{ width: 'auto' }}
                    value={draft.expire_at}
                    onChange={(e) => setDraft((d) => ({ ...d, expire_at: e.target.value }))}
                  />
                  <span className="dash-edit-hint">留空=长期记忆</span>
                </div>
                <input
                  className="dash-edit-input"
                  placeholder="主题（key）"
                  value={draft.key}
                  onChange={(e) => setDraft((d) => ({ ...d, key: e.target.value }))}
                />
                <textarea
                  className="dash-edit-textarea"
                  placeholder="内容（value）"
                  value={draft.value}
                  onChange={(e) => setDraft((d) => ({ ...d, value: e.target.value }))}
                />
                <div className="dash-edit-actions">
                  <button type="button" className="dash-btn ghost" onClick={() => setEditId(null)} disabled={busy}>取消</button>
                  <button type="button" className="dash-btn primary" onClick={() => saveEdit(m.id)} disabled={busy || !draft.key.trim()}>保存</button>
                </div>
              </div>
            ) : (
              <div className="info">
                <div className="title">
                  {(m.key || KIND_LABEL[m.kind]) ?? '记忆'}
                  {conflict && (
                    <span className="dash-badge-warn" style={{ marginLeft: 8 }} title="这条记忆和另外几条主题相近，可能是重复">
                      可能重复 · {group.length} 条
                    </span>
                  )}
                  {expired && <span className="dash-badge-warn" style={{ marginLeft: 8 }}>已过期</span>}
                </div>
                <div className={`desc ${opened ? 'expanded' : ''}`}>{opened || m.value.length <= 80 ? m.value : `${m.value.slice(0, 80)}…`}</div>
                <div className="meta">
                  <span className="tag">{KIND_LABEL[m.kind] ?? m.kind}</span>
                  <span>{fmtDate(m.updated_at)}</span>
                  {m.expire_at && <span title="过期时间">⏳ {fmtDate(m.expire_at)}</span>}
                  {m.value && m.value.length > 80 && (
                    <button type="button" className="dash-link" onClick={() => setOpen(toggleSet(open, m.id))}>
                      {opened ? '收起' : '展开'}
                    </button>
                  )}
                </div>
                <div className="meta" style={{ marginTop: 6 }}>
                  <button
                    type="button"
                    className="dash-link act"
                    onClick={() => onSend(`关于「${m.key || m.value.slice(0, 12)}」，帮我安排一下`)}
                    title="让栖光基于这条记忆做点事"
                  >
                    用它起个头 →
                  </button>
                  {conflict && (
                    <button
                      type="button"
                      className="dash-btn"
                      onClick={() => mergeGroup(group)}
                      disabled={busy}
                      title={`把这 ${group.length} 条合并，保留信息最完整的一条`}
                    >
                      合并重复
                    </button>
                  )}
                  <button type="button" className="dash-btn" onClick={() => startEdit(m)} disabled={busy}>编辑</button>
                  {confirming ? (
                    <span className="dash-confirm">
                      确认删除？
                      <button type="button" className="dash-btn danger" onClick={() => runOp(async () => { await api.deleteMemory(m.id); setConfirmId(null); })} disabled={busy}>删除</button>
                      <button type="button" className="dash-btn ghost" onClick={() => setConfirmId(null)} disabled={busy}>取消</button>
                    </span>
                  ) : (
                    <button type="button" className="dash-btn danger" onClick={() => { setEditId(null); setConfirmId(m.id); }} disabled={busy}>删除</button>
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default MemoryPane;
