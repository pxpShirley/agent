import { INTENT_META, STATUS_META } from '../types';
import type { IntentCode, SessionStatus } from '../types';

interface IntentBadgeProps {
  intent?: IntentCode | null;
  label?: string | null;
  size?: 'sm' | 'md';
}

export function IntentBadge({ intent, label, size = 'sm' }: IntentBadgeProps) {
  const meta = INTENT_META[(intent || 'other') as IntentCode];
  const text = label || meta.label;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full font-medium whitespace-nowrap ${
        size === 'sm' ? 'text-[11px] px-2 py-[2px]' : 'text-xs px-2.5 py-1'
      }`}
      style={{ color: meta.color, backgroundColor: meta.bg }}
    >
      <span aria-hidden>{meta.icon}</span>
      {text}
    </span>
  );
}

export function StatusBadge({ status }: { status: SessionStatus }) {
  const meta = STATUS_META[status] || STATUS_META.bot;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full text-[11px] px-2 py-[2px] font-medium whitespace-nowrap"
      style={{ color: meta.color, backgroundColor: meta.bg }}
    >
      <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: meta.color }} />
      {meta.label}
    </span>
  );
}
