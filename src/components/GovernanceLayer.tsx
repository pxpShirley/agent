import { useCallback, useEffect, useState } from 'react';
import api from '../api';
import type { AgentRun, PendingQuestion, AdminMemory, ProactiveCard } from '../types';
import { RuntimeSettings } from './RuntimeSettings';
import { formatTime } from '../utils/format';
import './GovernanceLayer.css';

const KIND_LABEL: Record<string, string> = {
  morning: '晨报',
  reminder_due: '到期提醒',
  weekly: '周复盘',
  nudge: '关怀',
};

type Tab = 'supervise' | 'settings';

/**
 * 治理与设置：关系界面内的统一监督 + 调整面板（非独立后管页）。
 * - 监督：活动流 / 例外收件箱 / 主动洞察 / 记忆与人格
 * - 运行设置：引擎凭证 / 运行模式 / 模型（RuntimeSettings）
 * 复用 CommandDeck 的同批数据，以居中玻璃面板叠加在星核空间之上，
 * 让人「监督代理、按需调整」，而非「操作工具」。
 */
export function GovernanceLayer({
  theme,
  onToggleTheme,
  initialTab = 'supervise',
}: {
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  onClose?: () => void;
  initialTab?: Tab;
}) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [pending, setPending] = useState<PendingQuestion[]>([]);
  const [memories, setMemories] = useState<AdminMemory[]>([]);
  const [proactive, setProactive] = useState<ProactiveCard[]>([]);
  const [needsAuth, setNeedsAuth] = useState(false);
  const [token, setToken] = useState('');

  const load = useCallback(async () => {
    try {
      const [r, p, m, c] = await Promise.all([
        api.adminRuns(),
        api.adminPending(),
        api.adminMemories(),
        api.adminProactive(),
      ]);
      setRuns(r.runs);
      setPending(p.questions);
      setMemories(m.memories);
      setProactive(c.cards);
    } catch (e: any) {
      if (String(e?.message || '').includes('令牌') || String(e?.message || '').includes('ADMIN_AUTH'))
        setNeedsAuth(true);
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const { required } = await fetch('/api/admin/auth-required').then((x) => x.json());
        const has = typeof localStorage !== 'undefined' && !!localStorage.getItem('admin_token');
        if (required && !has) {
          setNeedsAuth(true);
          return;
        }
      } catch {
        /* ignore */
      }
      setNeedsAuth(false);
      load();
    })();
  }, [load]);

  const confirm = useCallback(async (id: string, decision: 'approve' | 'escalate' | 'defer' | 'cancel') => {
    setPending((prev) => prev.filter((q) => q.id !== id));
    try {
      await api.confirmQuestion(id, decision);
    } catch {
      /* ignore */
    }
  }, []);

  const delMem = useCallback(async (id: string) => {
    setMemories((prev) => prev.filter((m) => m.id !== id));
    try {
      await api.deleteAdminMemory(id);
    } catch {
      /* ignore */
    }
  }, []);

  const seen = useCallback(async (id: string) => {
    setProactive((prev) => prev.map((c) => (c.id === id ? { ...c, status: 'seen' } : c)));
    try {
      await api.proactiveSeen(id);
    } catch {
      /* ignore */
    }
  }, []);

  const dismiss = useCallback(async (id: string) => {
    setProactive((prev) => prev.filter((c) => c.id !== id));
    try {
      await api.proactiveDismiss(id);
    } catch {
      /* ignore */
    }
  }, []);

  /** A4：执行卡片上的服务端内联动作（完成打卡 / 顺延），成功后卡片即收起 */
  const runAction = useCallback(
    async (c: ProactiveCard, type: string) => {
      try {
        const res = await api.proactiveAction(c.id, type);
        if (res.ok) {
          setProactive((prev) => prev.filter((x) => x.id !== c.id));
          return;
        }
      } catch {
        /* ignore */
      }
      seen(c.id); // 兜底标已读，避免卡在可点状态
    },
    [seen],
  );

  const people = Array.from(new Set(memories.map((m) => m.owner)));
  const proPending = proactive.filter((c) => c.status !== 'dismissed');

  if (needsAuth) {
    return (
      <div className="nx-gov">
        <div className="nx-gov-inner">
          <div className="gv-body">
            <div className="gv-auth">
              <p className="gv-auth-title">该空间已启用访问令牌</p>
              <p className="gv-auth-sub">请输入管理员令牌以进入「治理与设置」。令牌仅保存在本地浏览器。</p>
              <input
                className="gv-input"
                type="password"
                placeholder="管理员令牌"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && token.trim()) {
                    localStorage.setItem('admin_token', token.trim());
                    setToken('');
                    setNeedsAuth(false);
                    load();
                  }
                }}
              />
              <button
                className="gv-btn primary"
                type="button"
                onClick={() => {
                  if (!token.trim()) return;
                  localStorage.setItem('admin_token', token.trim());
                  setToken('');
                  setNeedsAuth(false);
                  load();
                }}
              >
                进入
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="nx-gov">
      <div className="nx-gov-inner">
        <nav className="gv-tabs">
          <button className={`gv-tab ${tab === 'supervise' ? 'on' : ''}`} onClick={() => setTab('supervise')}>
            监督
            {pending.length > 0 && <span className="gv-tab-dot">{pending.length}</span>}
          </button>
          <button className={`gv-tab ${tab === 'settings' ? 'on' : ''}`} onClick={() => setTab('settings')}>
            运行设置
          </button>
          <div className="gv-tabs-spacer" />
          <button className="gv-theme-btn" onClick={onToggleTheme} title="切换深浅主题">
            {theme === 'dark' ? '浅色' : '深色'}
          </button>
        </nav>

        <div className="gv-body">
          {tab === 'supervise' ? (
            <>
            <div className="gv-overview" role="group" aria-label="治理概览">
              <div className="gv-ov-item primary">
                <span className="gv-ov-num">{pending.length}</span>
                <span className="gv-ov-lab">待你确认</span>
              </div>
              <div className="gv-ov-item">
                <span className="gv-ov-num">{runs.length}</span>
                <span className="gv-ov-lab">自主行动</span>
              </div>
              <div className="gv-ov-item">
                <span className="gv-ov-num">{proPending.length}</span>
                <span className="gv-ov-lab">主动洞察</span>
              </div>
              <div className="gv-ov-item">
                <span className="gv-ov-num">{memories.length}</span>
                <span className="gv-ov-lab">记忆条目</span>
              </div>
            </div>
            <div className="gv-grid">
              {/* 活动流 */}
              <section className="gv-col">
                <div className="gv-col-h">
                  活动流
                  {runs.length > 0 && <span className="gv-cnt">{runs.length}</span>}
                </div>
                {runs.length === 0 ? (
                  <div className="gv-empty">栖光还没开始自主行动</div>
                ) : (
                  runs.slice(0, 12).map((r) => (
                    <div className="gv-card row" key={r.id}>
                      <div className="gv-card-main">
                        <div className="gv-card-t">{r.prompt || '（无提示词）'}</div>
                        {r.tools_used && (
                          <div className="gv-card-b">工具 · {String(r.tools_used).split(',').join(' · ')}</div>
                        )}
                      </div>
                      <span className="gv-card-time">{formatTime(r.created_at)}</span>
                    </div>
                  ))
                )}
              </section>

              {/* 例外收件箱 */}
              <section className="gv-col">
                <div className="gv-col-h">
                  例外收件箱
                  {pending.length > 0 && <span className="gv-cnt gold">{pending.length}</span>}
                </div>
                {pending.length === 0 ? (
                  <div className="gv-empty">暂无待确认，栖光在自治中</div>
                ) : (
                  pending.map((q) => (
                    <div className="gv-card pending" key={q.id}>
                      <div className="gv-card-k">待确认</div>
                      <div className="gv-card-t">{q.question}</div>
                      <div className="gv-card-a">
                        <button className="gv-act primary" onClick={() => confirm(q.id, 'approve')}>准了</button>
                        <button className="gv-act" onClick={() => confirm(q.id, 'escalate')}>转交</button>
                        <button className="gv-act" onClick={() => confirm(q.id, 'defer')}>稍后</button>
                        <button className="gv-act ghost" onClick={() => confirm(q.id, 'cancel')}>取消</button>
                      </div>
                    </div>
                  ))
                )}
              </section>

              {/* 主动洞察 */}
              <section className="gv-col">
                <div className="gv-col-h">
                  主动洞察
                  {proPending.length > 0 && <span className="gv-cnt">{proPending.length}</span>}
                </div>
                {proPending.length === 0 ? (
                  <div className="gv-empty">栖光暂未主动发起</div>
                ) : (
                  proPending.map((c) => (
                    <div className="gv-card" key={c.id}>
                      <div className="gv-card-k">
                        {KIND_LABEL[c.kind] || c.kind} · {c.owner}
                      </div>
                      <div className="gv-card-t">{c.title}</div>
                      {c.body && <div className="gv-card-b">{c.body}</div>}
                      <div className="gv-card-a">
                        {(c.actions || [])
                          .filter(
                            (a) =>
                              c.status !== 'seen' &&
                              (a.type === 'complete' || a.type === 'snooze_hour' || a.type === 'snooze_day'),
                          )
                          .map((a) => (
                            <button
                              key={a.type}
                              className={a.type === 'complete' ? 'primary' : ''}
                              onClick={() => runAction(c, a.type)}
                            >
                              {a.label}
                            </button>
                          ))}
                        {c.status !== 'seen' && (
                          <button onClick={() => seen(c.id)}>已读</button>
                        )}
                        <button onClick={() => dismiss(c.id)}>忽略</button>
                      </div>
                    </div>
                  ))
                )}
              </section>

              {/* 记忆与人格 */}
              <section className="gv-col">
                <div className="gv-col-h">记忆与人格</div>
                <div className="gv-card">
                  <div className="gv-card-b">它认识的人：{people.join('、') || '—'}</div>
                </div>
                {memories.length === 0 ? (
                  <div className="gv-empty">还没有记住什么</div>
                ) : (
                  memories.slice(0, 10).map((m) => (
                    <div className="gv-card row" key={m.id}>
                      <div className="gv-card-b">
                        <b>{m.key}</b>
                        {m.value ? `：${m.value}` : ''}
                      </div>
                      <button className="gv-card-x" onClick={() => delMem(m.id)} title="忘记">
                        ×
                      </button>
                    </div>
                  ))
                )}
              </section>
            </div>
            </>
          ) : (
            <RuntimeSettings />
          )}
        </div>
      </div>
    </div>
  );
}

export default GovernanceLayer;
