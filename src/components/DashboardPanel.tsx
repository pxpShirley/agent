import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AgentContext, Artifact, ChatMessage } from '../types';
import { api } from '../api';
import { useDashOps } from './dashboard/useDashOps';
import { MemoryPane } from './dashboard/MemoryPane';
import { GoalsPane } from './dashboard/GoalsPane';
import { ArtifactsPane } from './dashboard/ArtifactsPane';

type Tab = 'memory' | 'goals' | 'artifacts';

const TABS: [Tab, string][] = [['memory', '记忆'], ['goals', '目标'], ['artifacts', '产物']];

interface Props {
  context: AgentContext | null;
  messages: ChatMessage[];
  onSend: (text: string) => void;
  /** 记忆/提醒被改动后，刷新外层上下文（重新拉取 /api/context） */
  onChanged?: () => void;
}

/**
 * 灵境仪表盘（页面内联区域，非 modal）：
 * 记忆沉淀 / 进行中目标 / 协同产物，全部以同一页面的内联面板呈现。
 * 从任意面板"发起"能力 → 统一 dispatch 回主页并发出。
 *
 * 本文件只做「外壳 + 数据装载 + 统计」，三个域的具体交互分别在
 * dashboard/MemoryPane、GoalsPane、ArtifactsPane 里。
 */
export function DashboardPanel({ context, messages, onSend, onChanged }: Props) {
  const [tab, setTab] = useState<Tab>('memory');
  const [arts, setArts] = useState<Artifact[]>([]);
  const { busy, notice, runOp } = useDashOps(onChanged);
  const ops = useMemo(() => ({ busy, runOp }), [busy, runOp]);

  // 拉取真实协同产物；后端不可达时从当前会话聚合兜底
  useEffect(() => {
    let alive = true;
    api.listArtifacts('guest')
      .then((r) => { if (alive) setArts(r.artifacts || []); })
      .catch(() => {
        if (!alive) return;
        const acc: Artifact[] = [];
        for (const m of messages) (m.artifacts || []).forEach((a) => acc.push(a));
        setArts(acc);
      });
    return () => { alive = false; };
  }, [messages]);

  const reloadArts = useCallback(async () => {
    const { artifacts } = await api.listArtifacts('guest');
    setArts(artifacts || []);
  }, []);

  const memories = context?.memories ?? [];
  const reminders = context?.reminders ?? [];
  const moods = context?.moods ?? [];

  const inProgressGoals = useMemo(() => reminders.filter((r) => r.done !== 1).length, [reminders]);
  const calmPct = useMemo(() => {
    if (!moods.length) return 86;
    const avg = moods.reduce((s, m) => s + (m.level ?? 0), 0) / moods.length;
    return Math.max(40, Math.min(99, Math.round(avg * 100)));
  }, [moods]);

  return (
    <div className="nx-dash">
      {/* 标题在外层侧视图标题行（灵境 · 我的），此处不再重复 */}

      {notice && <div className="nx-inline-notice" style={{ marginBottom: 10 }}>{notice}</div>}

      <div className="dash-stats">
        <div className="stat-card">
          <span className="stat-ico" aria-hidden>🧠</span>
          <div className="number">{memories.length}</div>
          <div className="label">记忆沉淀</div>
        </div>
        <div className="stat-card">
          <span className="stat-ico gold" aria-hidden>🎯</span>
          <div className="number gold">{inProgressGoals}</div>
          <div className="label">进行中目标</div>
        </div>
        <div className="stat-card">
          <span className="stat-ico" aria-hidden>📦</span>
          <div className="number">{arts.length}</div>
          <div className="label">协同产物</div>
        </div>
        <div className="stat-card">
          <span className="stat-ico gold" aria-hidden>💗</span>
          <div className="number gold">{calmPct}%</div>
          <div className="label">情绪平和度</div>
        </div>
      </div>

      <div className="dash-toolbar-row">
        <div className="dash-seg" role="tablist" aria-label="灵境分区">
          {TABS.map(([t, label]) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              className={`dash-seg-btn ${tab === t ? 'active' : ''}`}
              onClick={() => setTab(t)}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="dash-sub">栖光记住的、在做的、为你沉淀的</span>
      </div>

      <div className="dash-content">
        {tab === 'memory' && <MemoryPane memories={memories} onSend={onSend} ops={ops} />}
        {tab === 'goals' && <GoalsPane reminders={reminders} onSend={onSend} ops={ops} />}
        {tab === 'artifacts' && <ArtifactsPane arts={arts} onSend={onSend} ops={ops} onReloadArts={reloadArts} />}
      </div>
    </div>
  );
}

export default DashboardPanel;
