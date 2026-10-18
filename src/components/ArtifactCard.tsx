import { useState } from 'react';
import type { Artifact } from '../types';
import { api } from '../api';
import { artifactTypeLabel, artifactToMarkdown, downloadText } from '../utils/artifact';

interface Props {
  artifact: Artifact;
  onChanged?: () => void;
}

/** 产物卡片：可展开查看、可编辑、可导出 Markdown */
export function ArtifactCard({ artifact, onChanged }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(artifact.content);
  const [busy, setBusy] = useState(false);

  const preview = (artifact.content || '').length > 140 ? (artifact.content || '').slice(0, 140) + '…' : artifact.content || '（空）';

  const handleSave = async () => {
    setBusy(true);
    try {
      await api.updateArtifact(artifact.id, {
        title: artifact.title,
        content: draft,
        type: artifact.type,
      });
      setEditing(false);
      onChanged?.();
    } catch {
      /* 忽略 */
    } finally {
      setBusy(false);
    }
  };

  const handleExport = () => {
    const md = artifactToMarkdown({ ...artifact, content: editing ? draft : artifact.content });
    downloadText(`${artifact.title || 'artifact'}.md`, md);
  };

  return (
    <div className="artifact-card">
      <div className="artifact-head">
        <span className={`artifact-badge art-${artifact.type}`}>{artifactTypeLabel(artifact.type)}</span>
        <span className="artifact-title">{artifact.title}</span>
        <span className="artifact-meta">v{artifact.version}</span>
      </div>
      <div className="artifact-body">
        {editing ? (
          <textarea
            className="artifact-edit"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={8}
          />
        ) : (
          <pre className="artifact-preview">{expanded ? artifact.content || '（空）' : preview}</pre>
        )}
      </div>
      <div className="artifact-actions">
        {editing ? (
          <>
            <button className="art-btn" disabled={busy} onClick={handleSave}>
              保存
            </button>
            <button className="art-btn ghost" onClick={() => { setEditing(false); setDraft(artifact.content); }}>
              取消
            </button>
          </>
        ) : (
          <>
            <button className="art-btn" onClick={() => setExpanded((v) => !v)}>
              {expanded ? '收起' : '展开'}
            </button>
            <button className="art-btn" onClick={() => { setDraft(artifact.content); setEditing(true); }}>
              编辑
            </button>
          </>
        )}
        <button className="art-btn primary" onClick={handleExport}>
          导出 Markdown
        </button>
      </div>
    </div>
  );
}
