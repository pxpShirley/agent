/**
 * 本地音乐索引的数据访问（M 音乐能力）
 *
 * 设计纪律：表里**只存路径与元数据**，音频文件本体永远留在用户磁盘上——
 * 不复制、不入库、不上传。删掉一条索引不等于删歌。
 */
import { v4 as uuidv4 } from 'uuid';
import { db, now } from './core.js';

export interface TrackRecord {
  id: string;
  path: string;
  title: string;
  artist: string | null;
  album: string | null;
  duration: number | null;
  mtime: number;
  size: number;
  play_count: number;
  last_played_at: string | null;
  created_at: string;
}

interface TrackRow {
  id: string;
  path: string;
  title: string;
  artist: string | null;
  album: string | null;
  duration: number | null;
  mtime: number;
  size: number;
  play_count: number;
  last_played_at: string | null;
  created_at: string;
}

function rowToRecord(r: TrackRow): TrackRecord {
  return {
    id: r.id,
    path: r.path,
    title: r.title,
    artist: r.artist,
    album: r.album,
    duration: r.duration,
    mtime: r.mtime,
    size: r.size,
    play_count: r.play_count,
    last_played_at: r.last_played_at,
    created_at: r.created_at,
  };
}

export interface TrackInput {
  path: string;
  title: string;
  artist?: string | null;
  album?: string | null;
  duration?: number | null;
  mtime: number;
  size: number;
}

/** 按路径幂等写入（同名重复扫描不会刷出重复行） */
export function upsertTrack(input: TrackInput): TrackRecord {
  const existing = db.prepare('SELECT * FROM tracks WHERE path = ?').get(input.path) as TrackRow | undefined;
  if (existing) {
    db.prepare(
      `UPDATE tracks SET title=?, artist=?, album=?, duration=?, mtime=?, size=? WHERE id=?`,
    ).run(
      input.title,
      input.artist ?? null,
      input.album ?? null,
      input.duration ?? null,
      input.mtime,
      input.size,
      existing.id,
    );
    return rowToRecord(db.prepare('SELECT * FROM tracks WHERE id = ?').get(existing.id) as TrackRow);
  }
  const id = uuidv4();
  db.prepare(
    `INSERT INTO tracks (id, path, title, artist, album, duration, mtime, size, play_count, last_played_at, created_at)
     VALUES (?,?,?,?,?,?,?,?,0,NULL,?)`,
  ).run(
    id,
    input.path,
    input.title,
    input.artist ?? null,
    input.album ?? null,
    input.duration ?? null,
    input.mtime,
    input.size,
    now(),
  );
  return rowToRecord(db.prepare('SELECT * FROM tracks WHERE id = ?').get(id) as TrackRow);
}

export function getTrack(id: string): TrackRecord | null {
  const r = db.prepare('SELECT * FROM tracks WHERE id = ?').get(id) as TrackRow | undefined;
  return r ? rowToRecord(r) : null;
}

/** 列表 / 搜索：q 同时匹配标题、艺术家、专辑 */
export function listTracks(q?: string, limit = 200): TrackRecord[] {
  const kw = (q || '').trim();
  const n = Math.max(1, Math.min(500, Number(limit) || 200));
  if (!kw) {
    return (db.prepare('SELECT * FROM tracks ORDER BY title COLLATE NOCASE LIMIT ?').all(n) as TrackRow[]).map(rowToRecord);
  }
  const like = `%${kw}%`;
  return (
    db
      .prepare(
        `SELECT * FROM tracks
         WHERE title LIKE ? OR artist LIKE ? OR album LIKE ?
         ORDER BY (CASE WHEN title LIKE ? THEN 0 WHEN artist LIKE ? THEN 1 ELSE 2 END), title COLLATE NOCASE
         LIMIT ?`,
      )
      .all(like, like, like, like, like, n) as TrackRow[]
  ).map(rowToRecord);
}

export function countTracks(): number {
  const r = db.prepare('SELECT COUNT(*) AS c FROM tracks').get() as { c: number };
  return r.c;
}

/** 读取全部路径（扫描时用于清理已删除的文件） */
export function allTrackPaths(): Array<{ id: string; path: string; mtime: number }> {
  return db.prepare('SELECT id, path, mtime FROM tracks').all() as Array<{ id: string; path: string; mtime: number }>;
}

export function deleteTrack(id: string): void {
  db.prepare('DELETE FROM tracks WHERE id = ?').run(id);
}

/** 播放计数（用于"最近播过降权"，避免重复推荐同一首） */
export function markPlayed(id: string): void {
  db.prepare('UPDATE tracks SET play_count = play_count + 1, last_played_at = ? WHERE id = ?').run(now(), id);
}
