import type { AgentContext } from '../types';

interface Props {
  context: AgentContext | null;
  busy: boolean;
}

const KIND_LABEL: Record<string, string> = {
  fact: '事实',
  preference: '偏好',
  plan: '计划',
  note: '随记',
};

const MOOD_FACE: Record<number, string> = { 1: '😞', 2: '😕', 3: '😐', 4: '🙂', 5: '😄' };

function fmtDue(dueAt: string | null, dueTs: number | null): string {
  if (dueTs === null) return dueAt || '随时'; // 解析不出的原文（如「最后一天」）原样显示
  const d = new Date(dueTs);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hh = `${d.getHours()}`.padStart(2, '0');
  const mm = `${d.getMinutes()}`.padStart(2, '0');
  if (sameDay) return `今天 ${hh}:${mm}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
}

export function AgentContextPanel({ context, busy }: Props) {
  const memories = context?.memories || [];
  const reminders = context?.reminders || [];
  const moods = context?.moods || [];

  return (
    <aside className="ctx-rail shrink-0 hidden lg:flex flex-col">
      <div className="ctx-head">
        <div className="flex items-center gap-2">
          <span className={`ctx-live ${busy ? 'is-busy' : ''}`} />
          <span className="ctx-title">管家此刻</span>
        </div>
        <span className="ctx-status">{busy ? '正在为你处理…' : '在线待命'}</span>
      </div>

      <div className="ctx-body">
        {/* 了解你 */}
        <section className="ctx-section">
          <div className="ctx-kicker">了解你</div>
          {memories.length ? (
            <div className="ctx-chips">
              {memories.slice(0, 8).map((m) => (
                <span key={m.id} className="ctx-chip">
                  <i className="ctx-chip-kind">{KIND_LABEL[m.kind] || '记'}</i>
                  {m.value}
                </span>
              ))}
            </div>
          ) : (
            <p className="ctx-empty">和栖光多聊聊，它会越来越懂你</p>
          )}
        </section>

        {/* 待办 & 提醒 */}
        <section className="ctx-section">
          <div className="ctx-kicker">待办 & 提醒</div>
          {reminders.length ? (
            <ul className="ctx-list">
              {reminders.slice(0, 6).map((r) => (
                <li key={r.id} className="ctx-item">
                  <span className="ctx-item-dot" />
                  <span className="ctx-item-body">{r.body}</span>
                  <span className="ctx-item-time">{fmtDue(r.due_at, r.due_ts)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="ctx-empty">还没有待办，交给栖光记一件？</p>
          )}
        </section>

        {/* 最近心情 */}
        <section className="ctx-section">
          <div className="ctx-kicker">最近心情</div>
          {moods.length ? (
            <div className="ctx-moods">
              {moods.slice(0, 6).map((m) => (
                <span key={m.id} className="ctx-mood" title={m.note || ''}>
                  {MOOD_FACE[m.level] || '😐'}
                </span>
              ))}
            </div>
          ) : (
            <p className="ctx-empty">栖光会陪你留意情绪</p>
          )}
        </section>
      </div>

      <div className="ctx-foot">
        记忆由栖光在对话中实时写入 · 仅本机演示
      </div>
    </aside>
  );
}
