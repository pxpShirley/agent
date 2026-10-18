import type { Express } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getChatModel } from '../settings.js';
import * as db from '../db.js';
import { notifyChanged } from '../realtime.js';
import { ctrlOwner, serializeMessage } from './shared.js';

export function registerSessions(app: Express): void {
app.get('/api/sessions', (_req, res) => {
  const sessions = db.getAllSessions().map((s) => {
    const messages = db.getMessagesBySession(s.id);
    return {
      ...s,
      messageCount: messages.length,
      lastMessage: messages.length ? messages[messages.length - 1].content.slice(0, 60) : '',
    };
  });
  res.json({ sessions });
});

app.post('/api/sessions', (req, res) => {
  const { title = '新的咨询', model = getChatModel(), customerName = '访客' } = req.body || {};
  const session = db.createSession({ id: uuidv4(), title, model, customer_name: customerName });
  res.json({ session });
});

app.get('/api/sessions/:sessionId', (req, res) => {
  const session = db.getSession(req.params.sessionId);
  if (!session) return res.status(404).json({ error: '会话不存在' });
  const messages = db.getMessagesBySession(session.id).map(serializeMessage);
  res.json({ session, messages });
});

app.delete('/api/sessions/:sessionId', (req, res) => {
  const ok = db.deleteSession(req.params.sessionId);
  if (!ok) return res.status(404).json({ error: '会话不存在' });
  res.json({ success: true });
});
}
