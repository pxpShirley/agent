import { v4 as uuidv4 } from 'uuid';
import { db, now } from './core.js';


export interface MoodRecord {
  id: string;
  owner: string;
  level: number;
  note: string;
  created_at: string;
}

export function addMood(owner: string, level: number, note = ''): MoodRecord {
  const row: MoodRecord = { id: uuidv4(), owner, level, note, created_at: now() };
  db.prepare(`INSERT INTO moods (id,owner,level,note,created_at) VALUES (@id,@owner,@level,@note,@created_at)`).run(row);
  return row;
}

export function recentMoods(owner: string, days = 14): MoodRecord[] {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  return db
    .prepare('SELECT * FROM moods WHERE owner = ? AND created_at >= ? ORDER BY created_at DESC')
    .all(owner, since) as MoodRecord[];
}
