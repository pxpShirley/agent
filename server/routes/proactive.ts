import type { Express } from 'express';
import * as db from '../db.js';
import { notifyChanged } from '../realtime.js';
import { ctrlOwner, serializeMessage } from './shared.js';

export function registerProactive(app: Express): void {
// 主动卡片：管家"不用你开口"也替你盯着的事（晨报 / 到期提醒 /月复盘）
app.get('/api/proactive', (req, res) => {
  const owner = (String(req.query.owner || '') || 'guest').slice(0, 64);
  res.json({ cards: db.getProactive(owner) });
});
app.post('/api/proactive/:id/seen', (req, res) => {
  const card = db.getProactiveCardById(req.params.id);
  if (card) db.recordProactiveFeedback(card.owner, card.id, card.kind, 'seen');
  const ok = db.markProactiveSeen(req.params.id);
  res.json({ success: ok });
});
app.post('/api/proactive/:id/dismiss', (req, res) => {
  const card = db.getProactiveCardById(req.params.id);
  if (card) db.recordProactiveFeedback(card.owner, card.id, card.kind, 'dismissed');
  const ok = db.dismissProactive(req.params.id);
  res.json({ success: ok });
});
// A4 主动卡内联动作：执行服务端分支（complete / snooze_*），客户端动作返回 clientOnly 让前端自行处理。
// owner 由卡片自身携带（单用户自用，但保留校验以防越权）。
app.post('/api/proactive/:id/action', (req, res) => {
  const { type } = (req.body || {}) as { type?: string };
  const card = db.getProactiveCardById(req.params.id);
  if (!card) {
    res.status(404).json({ ok: false, error: 'card-not-found' });
    return;
  }
  const result = db.executeProactiveAction(card.owner, req.params.id, type as any);
  if (!result.ok && result.error) {
    // 非法 type / 越权 / 已 dismissed → 4xx；客户端专属动作不走这里，返回 400
    const code = result.error === 'forbidden' ? 403 : result.error === 'invalid-type' ? 400 : 404;
    res.status(code).json(result);
    return;
  }
  if (result.ok) notifyChanged();
  res.json(result);
});
app.get('/api/proactive/feedback', (req, res) => {
  const owner = (String(req.query.owner || '') || 'guest').slice(0, 64);
  res.json({ feedback: db.getProactiveFeedback(owner), summary: db.summarizeFeedback(owner) });
});
}
