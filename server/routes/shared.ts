import * as db from '../db.js';

export function serializeMessage(m: db.DbMessage) {
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    model: m.model,
    intent: m.intent,
    createdAt: m.created_at,
  };
}

export function ctrlOwner(req: any): string {
  const o = String(req.query.owner || req.body?.owner || '' || 'guest').slice(0, 64);
  return o || 'guest';
}

