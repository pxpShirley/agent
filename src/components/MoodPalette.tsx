import type { XinglanMood } from './StarSprite';

/** 情绪调色板：手动让星澜呈现某一情绪态；再次点击或「自动」取消手动覆盖，回到运行时推导。 */
const MOODS: { id: XinglanMood; label: string; gold?: boolean }[] = [
  { id: 'calm', label: '平静' },
  { id: 'thinking', label: '思考' },
  { id: 'speaking', label: '说话' },
  { id: 'happy', label: '开心' },
  { id: 'concerned', label: '担忧' },
  { id: 'waiting', label: '等待你', gold: true },
  { id: 'sleeping', label: '安睡' },
];

interface Props {
  value: XinglanMood | null;
  onChange: (m: XinglanMood | null) => void;
}

export function MoodPalette({ value, onChange }: Props) {
  return (
    <div className="rs2-mood" role="group" aria-label="让栖光呈现某种情绪">
      {MOODS.map((m) => {
        const active = value === m.id;
        return (
          <button
            key={m.id}
            type="button"
            className={`rs2-mood-btn ${m.gold ? 'gold' : ''} ${active ? (m.gold ? 'gold-active' : 'active') : ''}`}
            aria-pressed={active}
            onClick={() => onChange(active ? null : m.id)}
            title={active ? '回到自动' : `让栖光呈现「${m.label}」`}
          >
            {m.label}
          </button>
        );
      })}
      {value && (
        <button type="button" className="rs2-mood-clear" onClick={() => onChange(null)} title="回到自动情绪">
          自动
        </button>
      )}
    </div>
  );
}
