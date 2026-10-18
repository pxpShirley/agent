import type { AgentStep } from '../types';

interface Props {
  steps: AgentStep[];
}

// 工具名 → 管家语态标签 + 线性图标（不使用 emoji，保持青绿液态玻璃调性）
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

function ToolGlyph({ name }: { name: string }) {
  switch (name) {
    case 'save_memory':
      return (
        <svg {...COMMON}>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M12 7.5v9M9 12h6" />
        </svg>
      );
    case 'recall_memory':
      return (
        <svg {...COMMON}>
          <path d="M4 12a8 8 0 1 1 2.3 5.6" />
          <path d="M4 19v-4h4" />
        </svg>
      );
    case 'set_reminder':
      return (
        <svg {...COMMON}>
          <path d="M18 8a6 6 0 1 0-12 0c0 6-2.5 7-2.5 7h17S18 14 18 8z" />
          <path d="M10.5 21a2 2 0 0 0 3 0" />
        </svg>
      );
    case 'get_schedule':
      return (
        <svg {...COMMON}>
          <rect x="3.5" y="4.5" width="17" height="16" rx="2.5" />
          <path d="M3.5 9h17M8 2.5v4M16 2.5v4M8 13h4" />
        </svg>
      );
    case 'checkin_mood':
      return (
        <svg {...COMMON}>
          <path d="M12 20s-7-4.4-7-9.3A4 4 0 0 1 12 7.4 4 4 0 0 1 19 10.7C19 15.6 12 20 12 20z" />
        </svg>
      );
    case 'ask_user':
      return (
        <svg {...COMMON}>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M9.5 9.5a2.5 2.5 0 1 1 3.4 2.3c-.8.4-1.4 1-1.4 2.2" />
          <path d="M12 17h.01" />
        </svg>
      );
    default:
      return (
        <svg {...COMMON}>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M12 8v5M12 16h.01" />
        </svg>
      );
  }
}

const TOOL_LABEL: Record<string, string> = {
  save_memory: '记入记忆',
  recall_memory: '回看记忆',
  set_reminder: '设置提醒',
  get_schedule: '查看日程',
  checkin_mood: '记录心情',
  ask_user: '请你确认',
};

// 从工具入参提炼一句人话（尽量可读）
function summarize(name: string, input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const i = input as Record<string, any>;
  if (name === 'save_memory') return i.value ? String(i.value).slice(0, 40) : null;
  if (name === 'set_reminder') return i.what ? String(i.what).slice(0, 40) : null;
  if (name === 'recall_memory') return i.query ? String(i.query).slice(0, 40) : null;
  if (name === 'checkin_mood') return i.note ? String(i.note).slice(0, 40) : null;
  if (name === 'ask_user') return i.question ? String(i.question).slice(0, 40) : null;
  return null;
}

export function AgentSteps({ steps }: Props) {
  if (!steps || steps.length === 0) return null;
  return (
    <div className="agent-steps">
      {steps.map((s) => {
        const isRunning = s.status === 'running';
        const label = TOOL_LABEL[s.name] || s.name;
        const sub = summarize(s.name, s.input);
        return (
          <div key={s.id} className={`agent-step ${isRunning ? 'is-running' : 'is-done'} ${s.error ? 'is-error' : ''}`}>
            <span className="agent-step-ico">
              {isRunning ? <span className="agent-spinner" /> : s.error ? <span className="agent-step-x">!</span> : <span className="agent-step-check">✓</span>}
            </span>
            <span className="agent-step-glyph">
              <ToolGlyph name={s.name} />
            </span>
            <span className="agent-step-label">
              {isRunning ? `正在${label}…` : label}
              {sub && <span className="agent-step-sub"> · {sub}</span>}
            </span>
          </div>
        );
      })}
    </div>
  );
}
