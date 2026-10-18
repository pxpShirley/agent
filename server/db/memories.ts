import { v4 as uuidv4 } from 'uuid';
import { db, now } from './core.js';

// Agent 记忆 / 提醒 / 情绪 / 遥测
// ============================================================
export interface MemoryRecord {
  id: string;
  owner: string;
  kind: string;
  key: string;
  value: string;
  updated_at: string;
  /** 过期时间（ISO）；时间绑定的事实到期后可由用户清理 */
  expire_at: string | null;
}

export function getMemories(owner: string, limit = 50): MemoryRecord[] {
  return db
    .prepare('SELECT * FROM memories WHERE owner = ? ORDER BY updated_at DESC LIMIT ?')
    .all(owner, limit) as MemoryRecord[];
}

export function saveMemory(owner: string, kind: string, key: string, value: string): MemoryRecord {
  const existing = db
    .prepare('SELECT * FROM memories WHERE owner = ? AND key = ?')
    .get(owner, key) as MemoryRecord | undefined;
  const ts = now();
  const row: MemoryRecord = {
    id: existing?.id || uuidv4(),
    owner,
    kind,
    key,
    value,
    updated_at: ts,
    expire_at: existing?.expire_at ?? null,
  };
  db.prepare(
    `INSERT INTO memories (id,owner,kind,key,value,updated_at)
     VALUES (@id,@owner,@kind,@key,@value,@updated_at)
     ON CONFLICT(id) DO UPDATE SET kind=@kind,key=@key,value=@value,updated_at=@updated_at`
  ).run(row);
  return row;
}

export function deleteMemory(id: string): boolean {
  return db.prepare('DELETE FROM memories WHERE id = ?').run(id).changes > 0;
}

export function getMemoryById(id: string): MemoryRecord | undefined {
  return db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRecord | undefined;
}

/** 归属安全的记忆编辑：仅更新传入字段，并刷新 updated_at。返回 null 表示记录不存在 */
export function updateMemory(
  id: string,
  patch: { kind?: string; key?: string; value?: string; expire_at?: string | null }
): MemoryRecord | null {
  const cur = getMemoryById(id);
  if (!cur) return null;
  const expire_at = patch.expire_at === undefined ? cur.expire_at ?? null : patch.expire_at;
  const row: MemoryRecord = {
    id: cur.id,
    owner: cur.owner,
    kind: patch.kind ?? cur.kind,
    key: patch.key ?? cur.key,
    value: patch.value ?? cur.value,
    updated_at: now(),
    expire_at,
  };
  db.prepare(
    `UPDATE memories SET kind=@kind, key=@key, value=@value, expire_at=@expire_at, updated_at=@updated_at WHERE id=@id`
  ).run(row);
  return row;
}

/**
 * 合并一组「主题重复」的记忆：保留信息最完整的那条（value 最长，同长取最近更新），删除其余。
 * 返回保留的记忆；可合并的不足 2 条时返回 null。
 */
export function mergeMemories(owner: string, ids: string[]): MemoryRecord | null {
  const rows = ids
    .map((id) => getMemoryById(id))
    .filter((m): m is MemoryRecord => !!m && m.owner === owner);
  if (rows.length < 2) return null;
  const winner = rows
    .slice()
    .sort((a, b) => b.value.length - a.value.length || (b.updated_at > a.updated_at ? 1 : -1))[0];
  for (const m of rows) if (m.id !== winner.id) deleteMemory(m.id);
  return winner;
}

/** 清理当前 owner 已过期（expire_at < 现在）的记忆，返回删除条数 */
export function cleanupExpiredMemories(owner: string): number {
  const ts = new Date().toISOString();
  return (
    db
      .prepare(
        "DELETE FROM memories WHERE owner = ? AND expire_at IS NOT NULL AND expire_at <> '' AND expire_at < ?"
      )
      .run(owner, ts).changes
  );
}
