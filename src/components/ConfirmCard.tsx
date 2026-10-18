import { useState } from 'react';
import type { PendingQuestion } from '../types';

export type Decision = 'approve' | 'escalate' | 'defer' | 'cancel';

interface Props {
  question: PendingQuestion;
  onConfirm: (id: string, decision: Decision, value?: string) => void;
}

const COMMON = {
  width: 16,
  height: 16,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

/** 从结构化动作里取出可编辑的草稿文本（待发送内容）；无则回退到问题本身 */
function draftOf(q: PendingQuestion): string {
  if (q.actionJson) {
    try {
      const a = JSON.parse(q.actionJson) as { text?: string };
      if (a && typeof a.text === 'string' && a.text.trim()) return a.text;
    } catch {
      /* ignore */
    }
  }
  return q.question;
}

const STATUS_BADGE: Record<PendingQuestion['status'], string> = {
  pending: '待确认',
  confirmed: '已批准',
  escalated: '已转交人工',
  deferred: '已稍后处理',
  cancelled: '已取消',
};

const STATUS_RESULT: Record<PendingQuestion['status'], string> = {
  pending: '',
  confirmed: '✅ 已批准并执行',
  escalated: '👤 已转交人工跟进',
  deferred: '⏸️ 已稍后处理',
  cancelled: '🚫 已取消，未执行',
};

/** 人在环：高风险动作前的确认卡。未确认时给出三类决策；已处理后展示结果。 */
export function ConfirmCard({ question, onConfirm }: Props) {
  const resolved = question.status !== 'pending';
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string>(() => draftOf(question));

  const decide = (decision: Decision, value?: string) => {
    setEditing(false);
    onConfirm(question.id, decision, value);
  };

  return (
    <div className={`confirm-card ${resolved ? 'is-resolved' : ''} ${question.status}`}>
      <div className="confirm-head">
        <svg {...COMMON} className="confirm-ico">
          <circle cx="12" cy="12" r="8.5" />
          <path d="M9.5 9.5a2.5 2.5 0 1 1 3.4 2.3c-.8.4-1.4 1-1.4 2.2" />
          <path d="M12 17h.01" />
        </svg>
        <span className="confirm-tag">需要你确认</span>
        {resolved && <span className={`confirm-badge ${question.status}`}>{STATUS_BADGE[question.status]}</span>}
      </div>

      <p className="confirm-q">{question.question}</p>

      {!resolved ? (
        <div className="confirm-actions">
          {editing ? (
            <>
              <textarea
                className="confirm-textarea"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={3}
                placeholder="修改待发送内容后批准…"
              />
              <div className="confirm-edit-row">
                <button className="confirm-btn primary" onClick={() => decide('approve', draft)}>
                  批准发送
                </button>
                <button
                  className="confirm-btn ghost"
                  onClick={() => {
                    setEditing(false);
                    setDraft(draftOf(question));
                  }}
                >
                  返回
                </button>
              </div>
            </>
          ) : (
            <>
              <button className="confirm-btn primary" onClick={() => decide('approve')}>
                ✓ 直接批准
              </button>
              <button className="confirm-btn" onClick={() => setEditing(true)}>
                改后批准
              </button>
              <button className="confirm-btn warn" onClick={() => decide('escalate')}>
                转交人工
              </button>
              <button className="confirm-btn info" onClick={() => decide('defer')}>
                稍后处理
              </button>
              <button className="confirm-btn ghost subtle" onClick={() => decide('cancel')}>
                取消
              </button>
            </>
          )}
        </div>
      ) : (
        <div className={`confirm-result ${question.status}`}>{STATUS_RESULT[question.status]}</div>
      )}
    </div>
  );
}
