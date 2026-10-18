import type { ArtifactVersion } from '../../types';
import { fmtDate } from './shared';

interface Props {
  /** 已加载的版本列表（父级懒加载后传入） */
  versions: ArtifactVersion[];
  busy: boolean;
  onRestore: (versionId: string) => void;
}

/** 产物版本历史：只读列表 + 恢复到某一版（恢复会把当前内容也存为新版） */
export function VersionHistory({ versions, busy, onRestore }: Props) {
  return (
    <div className="dash-versions">
      <div className="dash-versions-head">
        历史版本（共 {versions.length} 个，恢复会把当前内容也存为新版）
      </div>
      {versions.length === 0 && (
        <div className="dash-versions-empty">还没有历史版本——改动一次产物后即可追溯。</div>
      )}
      {versions.map((v) => (
        <div className="dash-version-row" key={v.id}>
          <span className="dash-version-tag">v{v.version}</span>
          <span className="dash-version-title">{v.title}</span>
          <span className="dash-version-time">{fmtDate(v.created_at)}</span>
          <button
            type="button"
            className="dash-btn"
            onClick={() => onRestore(v.id)}
            disabled={busy}
            title="把产物恢复到这一版"
          >
            恢复
          </button>
        </div>
      ))}
    </div>
  );
}

export default VersionHistory;
