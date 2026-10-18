import { useState } from 'react';
import { XinglanCore, type CoreState, type AgentPhase } from './XinglanCore';
import type { XinglanMood } from './StarSprite';
import { MoodPalette } from './MoodPalette';
import { AgentContextPanel } from './AgentContextPanel';
import type { AgentContext } from '../types';

const STATE_LABEL: Record<CoreState, string> = {
  idle: '静候',
  thinking: '思考中',
  speaking: '诉说中',
  listening: '聆听中',
};

interface Props {
  state: CoreState;
  energy: number;
  attention: boolean;
  waiting: boolean;
  accent: 'nebula' | 'warm';
  mood?: XinglanMood;
  caption?: string;
  agentPhase: Partial<Record<string, AgentPhase>>;
  agentDetail: Partial<Record<string, string>>;
  context: AgentContext | null;
  busy: boolean;
  moodManual: XinglanMood | null;
  onMoodChange: (m: XinglanMood | null) => void;
}

/**
 * 星澜陪伴面板：对话全程稳定在场的「形象 + 状态 + 上下文」侧栏。
 * - 形象（XinglanCore）直接复用「此刻」运行态：state/energy/mood/caption/agentPhase 由 messages+now+context 实时推导。
 * - 状态反馈：头部状态药丸随 idle/thinking/speaking/listening 切换；核心自身呈现呼吸 / 思考 / 诉说 / 等待动效与实时字幕。
 * - 可独立收起（不遮挡对话），移动端自动收为顶部紧凑条。
 */
export function CompanionPanel({
  state,
  energy,
  attention,
  waiting,
  accent,
  mood,
  caption,
  agentPhase,
  agentDetail,
  context,
  busy,
  moodManual,
  onMoodChange,
}: Props) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <aside className={`nx-companion${collapsed ? ' is-collapsed' : ''}`}>
      <div className="nx-companion-head">
        <div className="nx-companion-id">
          <span className="nx-companion-name">栖光</span>
          <span className={`nx-companion-pill state-${state}${waiting ? ' waiting' : ''}`}>
            <i className="nx-companion-dot" aria-hidden />
            {waiting ? '等你确认' : STATE_LABEL[state]}
          </span>
        </div>
        <button
          type="button"
          className="nx-companion-collapse"
          onClick={() => setCollapsed((c) => !c)}
          aria-label={collapsed ? '展开栖光陪伴面板' : '收起栖光陪伴面板'}
          title="展开 / 收起"
        >
          {collapsed ? '‹' : '›'}
        </button>
      </div>

      <div className="nx-companion-orb">
        <XinglanCore
          state={state}
          energy={energy}
          attention={attention}
          waiting={waiting}
          accent={accent}
          mood={mood}
          caption={caption}
          agentPhase={agentPhase}
          agentDetail={agentDetail}
        />
      </div>

      {!collapsed && (
        <>
          <div className="nx-companion-mood">
            <MoodPalette value={moodManual} onChange={onMoodChange} />
          </div>
          <div className="nx-companion-ctx">
            <AgentContextPanel context={context} busy={busy} />
          </div>
        </>
      )}
    </aside>
  );
}
