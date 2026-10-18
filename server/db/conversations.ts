import { v4 as uuidv4 } from 'uuid';
import { db, now } from './core.js';
import type { DbSession, DbMessage, IntentCode, SessionStatus } from './core.js';

// ============================================================
// 会话
// ============================================================
export function getAllSessions(): DbSession[] {
  return db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC').all() as DbSession[];
}

export function getSession(id: string): DbSession | undefined {
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as DbSession | undefined;
}

export function createSession(session: Partial<DbSession> & { id: string; title: string; model: string }): DbSession {
  const ts = now();
  const row: DbSession = {
    id: session.id,
    title: session.title,
    model: session.model,
    sdk_session_id: session.sdk_session_id ?? null,
    customer_name: session.customer_name ?? '访客',
    channel: session.channel ?? 'web',
    status: session.status ?? 'bot',
    intent: session.intent ?? 'other',
    resolved: session.resolved ?? 0,
    created_at: session.created_at ?? ts,
    updated_at: session.updated_at ?? ts,
  };
  db.prepare(
    `INSERT INTO sessions (id,title,model,sdk_session_id,customer_name,channel,status,intent,resolved,created_at,updated_at)
     VALUES (@id,@title,@model,@sdk_session_id,@customer_name,@channel,@status,@intent,@resolved,@created_at,@updated_at)`
  ).run(row);
  return row;
}

type SessionUpdatable = Pick<DbSession, 'title' | 'model' | 'sdk_session_id' | 'status' | 'intent' | 'resolved' | 'customer_name'>;

export function updateSession(id: string, updates: Partial<SessionUpdatable>): boolean {
  const fields: string[] = [];
  const values: any[] = [];
  (Object.keys(updates) as Array<keyof SessionUpdatable>).forEach((key) => {
    if (updates[key] !== undefined) {
      fields.push(`${key} = ?`);
      values.push(updates[key]);
    }
  });
  if (!fields.length) return false;
  fields.push('updated_at = ?');
  values.push(now(), id);
  return db.prepare(`UPDATE sessions SET ${fields.join(', ')} WHERE id = ?`).run(...values).changes > 0;
}

export function deleteSession(id: string): boolean {
  return db.prepare('DELETE FROM sessions WHERE id = ?').run(id).changes > 0;
}

// ============================================================
// 消息
// ============================================================
export function getMessagesBySession(sessionId: string): DbMessage[] {
  return db
    .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC, rowid ASC')
    .all(sessionId) as DbMessage[];
}

export function createMessage(message: Partial<DbMessage> & { id: string; session_id: string; role: DbMessage['role']; content: string }): DbMessage {
  const row: DbMessage = {
    id: message.id,
    session_id: message.session_id,
    role: message.role,
    content: message.content,
    model: message.model ?? null,
    intent: message.intent ?? null,
    created_at: message.created_at ?? now(),
    tool_calls: message.tool_calls ?? null,
  };
  db.prepare(
    `INSERT INTO messages (id,session_id,role,content,model,intent,created_at,tool_calls)
     VALUES (@id,@session_id,@role,@content,@model,@intent,@created_at,@tool_calls)`
  ).run(row);
  db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(now(), row.session_id);
  return row;
}

export function updateMessage(
  id: string,
  updates: Partial<Pick<DbMessage, 'content' | 'tool_calls' | 'intent'>>
): boolean {
  const fields: string[] = [];
  const values: any[] = [];
  (Object.keys(updates) as Array<keyof typeof updates>).forEach((key) => {
    if (updates[key] !== undefined) {
      fields.push(`${key} = ?`);
      values.push(updates[key]);
    }
  });
  if (!fields.length) return false;
  values.push(id);
  return db.prepare(`UPDATE messages SET ${fields.join(', ')} WHERE id = ?`).run(...values).changes > 0;
}

export function deleteMessage(id: string): boolean {
  return db.prepare('DELETE FROM messages WHERE id = ?').run(id).changes > 0;
}

// ============================================================
// 管理后台：列表与统计
// ============================================================
export interface ConversationRow extends DbSession {
  message_count: number;
  user_message_count: number;
  last_message: string | null;
}

export function listConversations(filter: {
  keyword?: string;
  intent?: string;
  status?: string;
}): ConversationRow[] {
  const where: string[] = [];
  const params: any[] = [];
  if (filter.intent && filter.intent !== 'all') {
    where.push('s.intent = ?');
    params.push(filter.intent);
  }
  if (filter.status && filter.status !== 'all') {
    where.push('s.status = ?');
    params.push(filter.status);
  }
  if (filter.keyword) {
    where.push('(s.title LIKE ? OR s.customer_name LIKE ? OR EXISTS (SELECT 1 FROM messages m2 WHERE m2.session_id = s.id AND m2.content LIKE ?))');
    const kw = `%${filter.keyword}%`;
    params.push(kw, kw, kw);
  }
  const sql = `
    SELECT s.*,
      (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count,
      (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id AND m.role = 'user') AS user_message_count,
      (SELECT m.content FROM messages m WHERE m.session_id = s.id ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1) AS last_message
    FROM sessions s
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY s.updated_at DESC
    LIMIT 300`;
  return db.prepare(sql).all(...params) as ConversationRow[];
}

export interface StatsResult {
  totals: {
    sessions: number;
    messages: number;
    userMessages: number;
    memoryCount: number;
    reminderCount: number;
    moodCount: number;
  };
  intentDistribution: Array<{ intent: string; count: number }>;
  hourlyEmotion: Array<{ hour: number; count: number }>;
  dailyTrend: Array<{ date: string; sessions: number }>;
}

export function getStats(days = 14): StatsResult {
  const since = new Date(Date.now() - (days - 1) * 86400000);
  since.setHours(0, 0, 0, 0);
  const sinceIso = since.toISOString();

  const totalSessions = (db.prepare('SELECT COUNT(*) c FROM sessions WHERE created_at >= ?').get(sinceIso) as { c: number }).c;
  const totalMessages = (
    db.prepare('SELECT COUNT(*) c FROM messages WHERE created_at >= ?').get(sinceIso) as { c: number }
  ).c;
  const userMessages = (
    db.prepare("SELECT COUNT(*) c FROM messages WHERE role='user' AND created_at >= ?").get(sinceIso) as { c: number }
  ).c;
  const memoryCount = (db.prepare('SELECT COUNT(*) c FROM memories').get() as { c: number }).c;
  const reminderCount = (db.prepare('SELECT COUNT(*) c FROM reminders WHERE done = 0').get() as { c: number }).c;
  const moodCount = (db.prepare("SELECT COUNT(*) c FROM moods WHERE created_at >= ?").get(sinceIso) as { c: number }).c;

  const intentDistribution = (
    db
      .prepare('SELECT intent, COUNT(*) AS count FROM sessions WHERE created_at >= ? GROUP BY intent ORDER BY count DESC')
      .all(sinceIso) as Array<{ intent: string; count: number }>
  ).map((r) => ({ intent: r.intent, count: r.count }));

  const dailyTrend: StatsResult['dailyTrend'] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const start = new Date(d);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start.getTime() + 86400000);
    const row = db
      .prepare('SELECT COUNT(*) c FROM sessions WHERE created_at >= ? AND created_at < ?')
      .get(start.toISOString(), end.toISOString()) as { c: number };
    dailyTrend.push({ date: key, sessions: row.c });
  }

  // 情绪陪伴类会话的「小时分布」——用于识别情绪高发时段
  const emoHourRows = db
    .prepare(
      `SELECT CAST(strftime('%H', created_at) AS INTEGER) AS hour, COUNT(*) AS c
       FROM sessions WHERE intent='emotion' AND created_at >= ? GROUP BY hour`
    )
    .all(sinceIso) as Array<{ hour: number; c: number }>;
  const emoHourMap = new Map<number, number>();
  for (const r of emoHourRows) emoHourMap.set(r.hour, r.c);
  const hourlyEmotion = Array.from({ length: 24 }, (_, h) => ({ hour: h, count: emoHourMap.get(h) || 0 }));

  return {
    totals: {
      sessions: totalSessions,
      messages: totalMessages,
      userMessages,
      memoryCount,
      reminderCount,
      moodCount,
    },
    intentDistribution,
    hourlyEmotion,
    dailyTrend,
  };
}

export interface PortraitResult {
  summary: {
    totalSessions: number;
    activeUsers: number;
    emotionShare: number;
    returnUserRate: number;
  };
  topUsers: Array<{ name: string; sessions: number; topIntent: string }>;
  intentMix: Array<{ intent: string; count: number }>;
  emotionByHour: Array<{ hour: number; count: number }>;
}

/** 跨会话聚合「了解你的用户」——运营侧用户画像 */
export function getPortrait(days = 30): PortraitResult {
  const since = new Date(Date.now() - (days - 1) * 86400000);
  since.setHours(0, 0, 0, 0);
  const sinceIso = since.toISOString();

  const totalSessions = (db.prepare('SELECT COUNT(*) c FROM sessions WHERE created_at >= ?').get(sinceIso) as { c: number }).c;
  const emotionSessions = (
    db.prepare("SELECT COUNT(*) c FROM sessions WHERE intent='emotion' AND created_at >= ?").get(sinceIso) as { c: number }
  ).c;

  const userRows = db
    .prepare('SELECT customer_name AS name, COUNT(*) c FROM sessions WHERE created_at >= ? GROUP BY customer_name')
    .all(sinceIso) as Array<{ name: string; c: number }>;
  const activeUsers = userRows.length;
  const returnUsers = userRows.filter((r) => r.c > 1).length;

  const topUsers = db
    .prepare(
      `SELECT s.customer_name AS name, COUNT(*) AS sessions, s.intent AS topIntent
       FROM sessions s WHERE s.created_at >= ? GROUP BY s.customer_name
       ORDER BY sessions DESC LIMIT 8`
    )
    .all(sinceIso) as Array<{ name: string; sessions: number; topIntent: string }>;

  const intentMix = (
    db.prepare('SELECT intent, COUNT(*) c FROM sessions WHERE created_at >= ? GROUP BY intent ORDER BY c DESC').all(
      sinceIso
    ) as Array<{ intent: string; c: number }>
  ).map((r) => ({ intent: r.intent, count: r.c }));

  const emoRows = db
    .prepare(
      `SELECT CAST(strftime('%H', created_at) AS INTEGER) AS hour, COUNT(*) c
       FROM sessions WHERE intent='emotion' AND created_at >= ? GROUP BY hour`
    )
    .all(sinceIso) as Array<{ hour: number; c: number }>;
  const emoMap = new Map<number, number>();
  for (const r of emoRows) emoMap.set(r.hour, r.c);
  const emotionByHour = Array.from({ length: 24 }, (_, h) => ({ hour: h, count: emoMap.get(h) || 0 }));

  const pct = (n: number, d: number) => (d > 0 ? Number(((n / d) * 100).toFixed(1)) : 0);
  return {
    summary: {
      totalSessions,
      activeUsers,
      emotionShare: pct(emotionSessions, totalSessions),
      returnUserRate: pct(returnUsers, activeUsers),
    },
    topUsers,
    intentMix,
    emotionByHour,
  };
}

export function clearConversations(): void {
  db.exec('DELETE FROM messages; DELETE FROM sessions;');
}

export function countSessions(): number {
  return (db.prepare('SELECT COUNT(*) c FROM sessions').get() as { c: number }).c;
}

/** 轻量活动快照：用于工作台实时轮询 */
export function getActivity(): { sessions: number } {
  const sessions = (db.prepare('SELECT COUNT(*) c FROM sessions').get() as { c: number }).c;
  return { sessions };
}

// ============================================================
