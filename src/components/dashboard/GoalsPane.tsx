import { useMemo, useState } from 'react';
import { api } from '../../api';
import { fmtDueLabel, isOverdue, toDateInput, type ReminderItem } from './shared';
import type { DashOps } from './useDashOps';
import { goalProgress } from './logic';

type GoalFilter = 'all' | 'open' | 'done';

/** 推迟选项：相对当前到期时间后移（'tomorrow' = 顺延到明天同一时刻） */
const SNOOZE_OPTS: { label: string; delta: number | 'tomorrow' }[] = [
  { label: '30 分钟', delta: 30 * 60_000 },
  { label: '1 小时', delta: 60 * 60_000 },
  { label: '明天同一时间', delta: 'tomorrow' },
];

/**
 * 给「问栖光」用的情境化快捷话术。
 * 默认给推进/分解/重新排；遇到休息类提醒（睡/休息/床…）额外给"想听歌"等
 * 委婉改向的话术——这样用户不必自己组织"我现在不想睡想听歌"这种句子，
 * 点一下就把清晰意图传给栖光，回复自然就聪明了。
 */
const askChipsFor = (r: ReminderItem): { label: string; text: string }[] => {
  const body = r.body || '';
  const isRest = /[睡休息觉床]|早睡|放松|躺|不想睡|还不想/.test(body);
  const chips: { label: string; text: string }[] = [];
  if (isRest) {
    chips.push({ label: '现在不想睡，放点歌', text: `「${body}」我现在还不想休息，先给我放点适合放松的音乐吧` });
    chips.push({ label: '推迟到明天', text: `把「${body}」推迟到明天同一时间` });
  }
  chips.push({ label: '帮我推进这件事', text: `帮我推进这件事：「${body}」` });
  chips.push({ label: '拆成子步骤', text: `帮我把「${body}」拆成几个可勾选的子步骤` });
  if (r.due_ts !== null) chips.push({ label: '时间往后挪一点', text: `把「${body}」的提醒时间往后挪一点` });
  chips.push({ label: '这事儿还重要吗？重新排', text: `「${body}」这事儿我现在不太想做，帮我重新排一下节奏` });
  return chips;
};

interface Props {
  reminders: ReminderItem[];
  onSend: (text: string) => void;
  ops: DashOps;
}

/** 目标面板（提醒/待办）：状态筛选 / 进度 / 编辑 / 完成前的删除与推进 */
export function GoalsPane({ reminders, onSend, ops }: Props) {
  const { busy, runOp } = ops;
  const [filter, setFilter] = useState<GoalFilter>('all');
  const [editId, setEditId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ body: string; due_at: string }>({ body: '', due_at: '' });
  const [addingId, setAddingId] = useState<string | null>(null);
  const [newStep, setNewStep] = useState('');
  const [snoozeId, setSnoozeId] = useState<string | null>(null);
  const [askId, setAskId] = useState<string | null>(null);

  /** 进度：有子步骤时按「完成步数/总步数」，否则沿用时间线性进度 */
  const progressPct = (r: ReminderItem): number =>
    r.steps.length ? Math.round((r.steps.filter((s) => s.done === 1).length / r.steps.length) * 100) : goalProgress(r);

  const addStep = (id: string) =>
    runOp(async () => {
      const cur = reminders.find((x) => x.id === id);
      if (!cur) return;
      const steps = [
        ...cur.steps.map((s) => ({ text: s.text, done: s.done })),
        { text: newStep.trim() },
      ];
      await api.setReminderSteps(id, steps);
      setNewStep('');
      setAddingId(null);
    });

  /** 推迟：直接改 due_at（后端会同步重算 due_ts），纯前端即可，无需新接口 */
  const snooze = (r: ReminderItem, delta: number | 'tomorrow') =>
    runOp(async () => {
      const base = r.due_ts ?? Date.now();
      const ts =
        typeof delta === 'number'
          ? base + delta
          : (() => {
              const d = new Date(base);
              d.setDate(d.getDate() + 1);
              return d.getTime();
            })();
      await api.updateReminder(r.id, { due_at: new Date(ts).toISOString() });
    });

  const filtered = useMemo(() => {
    if (filter === 'open') return reminders.filter((r) => r.done !== 1);
    if (filter === 'done') return reminders.filter((r) => r.done === 1);
    return reminders;
  }, [reminders, filter]);

  const startEdit = (r: ReminderItem) => {
    setEditId(r.id);
    setConfirmId(null);
    // 用 due_ts 回填日期选择器：直接 slice 原文会得到「10月7日 晚上 22」这种垃圾
    setDraft({ body: r.body || '', due_at: toDateInput(r.due_ts) });
  };
  const saveEdit = (id: string) =>
    runOp(async () => {
      const due_at = draft.due_at ? new Date(draft.due_at).toISOString() : null;
      await api.updateReminder(id, { body: draft.body, due_at });
      setEditId(null);
    });

  return (
    <div className="dash-pane">
      <div className="dash-toolbar">
        <div className="dash-seg">
          {([['all', '全部'], ['open', '进行中'], ['done', '已完成']] as [GoalFilter, string][]).map(([f, label]) => (
            <button key={f} type="button" className={`dash-seg-btn ${filter === f ? 'active' : ''}`} onClick={() => setFilter(f)}>{label}</button>
          ))}
        </div>
      </div>

      {filtered.length === 0 && (
        <div className="dash-empty">
          <span className="dash-empty-ico">🎯</span>
          <div className="dash-empty-title">{reminders.length === 0 ? '还没有进行中的目标' : '这一栏暂时是空的'}</div>
          <div className="dash-empty-hint">{reminders.length === 0 ? '和栖光说一件这周想推进的事，他会陪你把节奏和提醒都排好。' : '切换筛选看看其他状态。'}</div>
        </div>
      )}
      {filtered.slice(0, 40).map((r) => {
        const done = r.done === 1;
        const overdue = isOverdue(r);
        const isRecur = !!r.recur_rule;
        const editing = editId === r.id;
        const confirming = confirmId === r.id;
        const pct = progressPct(r);
        const hasSteps = r.steps.length > 0;
        return (
          <div className={`panel-card ${done ? 'done' : ''}`} key={r.id}>
            <div className="icon-wrap" aria-hidden><span className="icon">🎯</span></div>
            {editing ? (
              <div className="dash-edit-form">
                <textarea
                  className="dash-edit-textarea"
                  placeholder="这件事要做什么"
                  value={draft.body}
                  onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))}
                />
                <div className="dash-edit-row">
                  <span className="dash-edit-label">到期</span>
                  <input
                    className="dash-edit-input"
                    type="date"
                    style={{ width: 'auto' }}
                    value={draft.due_at}
                    onChange={(e) => setDraft((d) => ({ ...d, due_at: e.target.value }))}
                  />
                  <span className="dash-edit-hint">留空=无期限</span>
                </div>
                <div className="dash-edit-actions">
                  <button type="button" className="dash-btn ghost" onClick={() => setEditId(null)} disabled={busy}>取消</button>
                  <button type="button" className="dash-btn primary" onClick={() => saveEdit(r.id)} disabled={busy || !draft.body.trim()}>保存</button>
                </div>
              </div>
            ) : (
              <div className="info">
                <div className="title">
                  {r.body}
                  {overdue && !isRecur && <span className="dash-badge-warn" style={{ marginLeft: 8 }}>已逾期</span>}
                </div>
                <div className="meta">
                  <span className={`tag ${done ? '' : 'gold'}`}>{done ? '已完成' : '进行中'}</span>
                  {isRecur && <span className="recur-tag" title="周期 / 习惯提醒，完成一期会自动排下一期">🔁 {r.due_at}</span>}
                  {r.due_ts !== null && (
                    <span title={isRecur ? '下一期时间' : '到期时间'}>⏳ {fmtDueLabel(r)}{!isRecur && overdue ? '（已逾期）' : ''}</span>
                  )}
                </div>
                <div className="rem-actions">
                  {!done && (
                    <button
                      type="button"
                      className="dash-btn primary"
                      onClick={() => runOp(() => api.completeReminder(r.id))}
                      disabled={busy}
                      title={isRecur ? '打卡：完成这一期，自动排好下一期' : '标记这件事已完成'}
                    >
                      {isRecur ? '打卡 ✓' : '完成 ✓'}
                    </button>
                  )}
                  {!done && !isRecur && (
                    <button
                      type="button"
                      className="dash-btn"
                      onClick={() => setSnoozeId(snoozeId === r.id ? null : r.id)}
                      disabled={busy}
                      aria-expanded={snoozeId === r.id}
                      title="推迟提醒"
                    >
                      推迟 ▾
                    </button>
                  )}
                  {!done && (
                    <button
                      type="button"
                      className={`dash-btn${askId === r.id ? ' on' : ''}`}
                      onClick={() => setAskId(askId === r.id ? null : r.id)}
                      disabled={busy}
                      aria-expanded={askId === r.id}
                      title="和栖光聊聊这件事（带情境建议）"
                    >
                      问栖光
                    </button>
                  )}
                  {!done && !isRecur && (
                    <button type="button" className="dash-link" onClick={() => startEdit(r)} disabled={busy}>编辑</button>
                  )}
                  {!done && (
                    confirming ? (
                      <span className="dash-confirm">
                        确认删除？
                        <button type="button" className="dash-btn danger" onClick={() => runOp(async () => { await api.deleteReminder(r.id); setConfirmId(null); })} disabled={busy}>删除</button>
                        <button type="button" className="dash-btn ghost" onClick={() => setConfirmId(null)} disabled={busy}>取消</button>
                      </span>
                    ) : (
                      <button type="button" className="dash-btn danger" onClick={() => { setEditId(null); setConfirmId(r.id); }} disabled={busy}>
                        {isRecur ? '停止习惯' : '删除'}
                      </button>
                    )
                  )}
                </div>
                {!done && snoozeId === r.id && (
                  <div className="dash-snooze" role="menu">
                    {SNOOZE_OPTS.map((o) => (
                      <button
                        key={o.label}
                        type="button"
                        className="dash-snooze-opt"
                        disabled={busy}
                        onClick={() => { snooze(r, o.delta); setSnoozeId(null); }}
                      >
                        {o.label}
                      </button>
                    ))}
                  </div>
                )}
                {!done && askId === r.id && (
                  <div className="dash-ask" role="menu">
                    {askChipsFor(r).map((c) => (
                      <button
                        key={c.text}
                        type="button"
                        className="dash-chip"
                        disabled={busy}
                        onClick={() => { onSend(c.text); setAskId(null); }}
                      >
                        {c.label}
                      </button>
                    ))}
                  </div>
                )}
                {hasSteps && (
                  <div className="dash-steps">
                    {r.steps.map((s) => (
                      <label className="dash-step" key={s.seq}>
                        <input
                          type="checkbox"
                          checked={s.done === 1}
                          disabled={busy}
                          onChange={() => runOp(() => api.toggleReminderStep(r.id, s.seq))}
                        />
                        <span className={s.done === 1 ? 'done' : ''}>{s.text}</span>
                      </label>
                    ))}
                    {addingId === r.id ? (
                      <div className="dash-step-add">
                        <input
                          className="dash-edit-input"
                          type="text"
                          autoFocus
                          placeholder="新子步骤…"
                          value={newStep}
                          onChange={(e) => setNewStep(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter' && newStep.trim()) addStep(r.id); }}
                        />
                        <button type="button" className="dash-btn primary" disabled={busy || !newStep.trim()} onClick={() => addStep(r.id)}>加</button>
                        <button type="button" className="dash-btn ghost" onClick={() => { setAddingId(null); setNewStep(''); }}>取消</button>
                      </div>
                    ) : (
                      <button type="button" className="dash-link" onClick={() => { setAddingId(r.id); setNewStep(''); }} disabled={busy}>＋ 子步骤</button>
                    )}
                  </div>
                )}
                {!done && <div className="progress-bar"><div className={`fill ${done ? '' : 'gold'}`} style={{ width: `${pct}%` }} /></div>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default GoalsPane;
