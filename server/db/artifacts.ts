import { v4 as uuidv4 } from 'uuid';
import { db, now } from './core.js';

// 产物（Artifact）：Agent 交付的结构化对象
// ============================================================
export interface ArtifactRecord {
  id: string;
  owner: string;
  session_id: string | null;
  type: 'itinerary' | 'report' | 'checklist' | 'note';
  title: string;
  content: string; // JSON 或 Markdown 文本
  version: number;
  created_at: string;
  updated_at: string;
}

export function createArtifact(a: {
  owner: string;
  session_id?: string | null;
  type?: ArtifactRecord['type'];
  title: string;
  content?: string;
}): ArtifactRecord {
  const ts = now();
  const row: ArtifactRecord = {
    id: uuidv4(),
    owner: a.owner || 'guest',
    session_id: a.session_id ?? null,
    type: a.type ?? 'note',
    title: a.title,
    content: a.content ?? '{}',
    version: 1,
    created_at: ts,
    updated_at: ts,
  };
  db.prepare(
    `INSERT INTO artifacts (id,owner,session_id,type,title,content,version,created_at,updated_at)
     VALUES (@id,@owner,@session_id,@type,@title,@content,@version,@created_at,@updated_at)`
  ).run(row);
  return row;
}

export function getArtifacts(owner: string, limit = 50): ArtifactRecord[] {
  return db
    .prepare('SELECT * FROM artifacts WHERE owner = ? ORDER BY updated_at DESC LIMIT ?')
    .all(owner, limit) as ArtifactRecord[];
}

export function getArtifact(id: string): ArtifactRecord | undefined {
  return db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as ArtifactRecord | undefined;
}

export function updateArtifact(
  id: string,
  patch: { title?: string; content?: string; type?: ArtifactRecord['type'] }
): boolean {
  const fields: string[] = [];
  const values: any[] = [];
  if (patch.title !== undefined) {
    fields.push('title = ?');
    values.push(patch.title);
  }
  if (patch.content !== undefined) {
    fields.push('content = ?');
    values.push(patch.content);
  }
  if (patch.type !== undefined) {
    fields.push('type = ?');
    values.push(patch.type);
  }
  if (!fields.length) return false;
  // 改动前先快照当前版本，保证任何一次编辑都可追溯 / 可回滚
  snapshotArtifactVersion(id);
  fields.push('version = version + 1');
  fields.push('updated_at = ?');
  values.push(now(), id);
  return db.prepare(`UPDATE artifacts SET ${fields.join(', ')} WHERE id = ?`).run(...values).changes > 0;
}

// ---- 产物版本历史 ----
export interface ArtifactVersion {
  id: string;
  artifact_id: string;
  version: number;
  title: string;
  content: string;
  type: string;
  created_at: string;
}

/** 把产物当前内容存为一条历史版本（无产物或已存过同版本则跳过） */
export function snapshotArtifactVersion(artifactId: string): ArtifactVersion | null {
  const a = getArtifact(artifactId);
  if (!a) return null;
  const dup = db
    .prepare('SELECT 1 FROM artifact_versions WHERE artifact_id = ? AND version = ? LIMIT 1')
    .get(artifactId, a.version);
  if (dup) return null; // 同一版本不重复快照
  const row: ArtifactVersion = {
    id: uuidv4(),
    artifact_id: artifactId,
    version: a.version,
    title: a.title,
    content: a.content,
    type: a.type,
    created_at: now(),
  };
  db.prepare(
    `INSERT INTO artifact_versions (id,artifact_id,version,title,content,type,created_at)
     VALUES (@id,@artifact_id,@version,@title,@content,@type,@created_at)`
  ).run(row);
  return row;
}

/** 某产物的历史版本（新的在前） */
export function listArtifactVersions(artifactId: string): ArtifactVersion[] {
  return db
    .prepare('SELECT * FROM artifact_versions WHERE artifact_id = ? ORDER BY version DESC')
    .all(artifactId) as ArtifactVersion[];
}

/**
 * 回滚到指定历史版本：先把当前内容也存一份（避免回滚本身造成内容丢失），
 * 再把历史内容写回产物。返回回滚后的产物，失败返回 null。
 */
export function restoreArtifactVersion(artifactId: string, versionId: string): ArtifactRecord | null {
  const v = db
    .prepare('SELECT * FROM artifact_versions WHERE id = ? AND artifact_id = ?')
    .get(versionId, artifactId) as ArtifactVersion | undefined;
  if (!v) return null;
  const a = getArtifact(artifactId);
  if (!a) return null;
  snapshotArtifactVersion(artifactId); // 保留"回滚前"的状态
  const ts = now();
  db.prepare('UPDATE artifacts SET title = ?, content = ?, type = ?, version = version + 1, updated_at = ? WHERE id = ?')
    .run(v.title, v.content, v.type, ts, artifactId);
  return getArtifact(artifactId) ?? null;
}

export function deleteArtifact(id: string): boolean {
  return db.prepare('DELETE FROM artifacts WHERE id = ?').run(id).changes > 0;
}
