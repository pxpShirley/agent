import { useState } from 'react';
import { api } from '../../api';
import type { Artifact, ArtifactVersion } from '../../types';
import { ARTIFACT_ICON, ARTIFACT_LABEL, fmtDate, toggleSet } from './shared';
import type { DashOps } from './useDashOps';
import { VersionHistory } from './VersionHistory';

interface Props {
  arts: Artifact[];
  onSend: (text: string) => void;
  ops: DashOps;
  /** 恢复版本后重新拉取产物列表（列表状态在父级，因为它同时供给顶部统计） */
  onReloadArts: () => Promise<void>;
}

/** 产物面板：全文展开 / 复制 / 版本历史与回滚 / 打开 */
export function ArtifactsPane({ arts, onSend, ops, onReloadArts }: Props) {
  const { busy, runOp } = ops;
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [histId, setHistId] = useState<string | null>(null);
  const [versions, setVersions] = useState<Record<string, ArtifactVersion[]>>({});
  const [copied, setCopied] = useState<string | null>(null);

  const copyArtifact = (id: string, text: string) => {
    navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(id);
        setTimeout(() => setCopied((c) => (c === id ? null : c)), 1600);
      },
      () => {},
    );
  };

  /** 版本历史：展开即拉取 */
  const toggleHistory = (id: string) => {
    if (histId === id) {
      setHistId(null);
      return;
    }
    setHistId(id);
    if (!versions[id]) {
      api.listArtifactVersions(id)
        .then((r) => setVersions((v) => ({ ...v, [id]: r.versions || [] })))
        .catch(() => setVersions((v) => ({ ...v, [id]: [] })));
    }
  };

  const restoreVersion = (artifactId: string, versionId: string) =>
    runOp(async () => {
      await api.restoreArtifactVersion(artifactId, versionId);
      setHistId(null);
      setVersions((v) => {
        const next = { ...v };
        delete next[artifactId];
        return next;
      });
      await onReloadArts();
    });

  return (
    <div className="dash-pane">
      {arts.length === 0 && (
        <div className="dash-empty">
          <span className="dash-empty-ico">📦</span>
          <div className="dash-empty-title">还没有协同产物</div>
          <div className="dash-empty-hint">让栖光帮你做一份行程、报告或清单，做完会沉淀在这里随时取用。</div>
        </div>
      )}
      {arts.map((a) => {
        const opened = open.has(a.id);
        const longContent = a.content.length > 60;
        return (
          <div className="panel-card" key={a.id}>
            <div className="icon-wrap" aria-hidden><span className="icon">{ARTIFACT_ICON[a.type] ?? '📝'}</span></div>
            <div className="info">
              <div className="title">{a.title}</div>
              <div className={`desc ${opened ? 'expanded' : ''}`}>{opened || a.content.length <= 60 ? a.content : `${a.content.slice(0, 60)}…`}</div>
              <div className="meta">
                <span className="tag">{ARTIFACT_LABEL[a.type] ?? a.type}</span>
                <span>v{a.version}</span>
                <span>{fmtDate(a.updated_at)}</span>
                {longContent && (
                  <button type="button" className="dash-link" onClick={() => setOpen(toggleSet(open, a.id))}>
                    {opened ? '收起' : '展开'}
                  </button>
                )}
                <button type="button" className="dash-link" onClick={() => toggleHistory(a.id)} disabled={busy}>
                  {histId === a.id ? '收起历史' : '历史'}
                </button>
                <button
                  type="button"
                  className="dash-link act"
                  onClick={() => copyArtifact(a.id, a.content)}
                  title="复制产物内容"
                >
                  {copied === a.id ? '已复制 ✓' : '复制'}
                </button>
              </div>
              {histId === a.id && (
                <VersionHistory
                  versions={versions[a.id] || []}
                  busy={busy}
                  onRestore={(versionId) => restoreVersion(a.id, versionId)}
                />
              )}
            </div>
            <button className="action-btn primary" onClick={() => onSend(`打开产物《${a.title}》`)}>打开</button>
          </div>
        );
      })}
    </div>
  );
}

export default ArtifactsPane;
