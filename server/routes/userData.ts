import type { Express } from 'express';
import * as db from '../db.js';
import { notifyChanged } from '../realtime.js';
import { ctrlOwner, serializeMessage } from './shared.js';

export function registerUserData(app: Express): void {
app.put('/api/memories/:id', (req, res) => {
  const owner = ctrlOwner(req);
  const mem = db.getMemoryById(req.params.id);
  if (!mem || mem.owner !== owner) return res.status(404).json({ error: '记忆不存在' });
  const { kind, key, value, expire_at } = req.body || {};
  const updated = db.updateMemory(req.params.id, {
    kind: kind !== undefined ? String(kind) : undefined,
    key: key !== undefined ? String(key) : undefined,
    value: value !== undefined ? String(value) : undefined,
    expire_at: expire_at === undefined ? undefined : expire_at === null || expire_at === '' ? null : String(expire_at),
  });
  if (!updated) return res.status(404).json({ error: '记忆不存在' });
  notifyChanged();
  res.json({ memory: updated });
});

app.delete('/api/memories/:id', (req, res) => {
  const owner = ctrlOwner(req);
  const mem = db.getMemoryById(req.params.id);
  if (!mem || mem.owner !== owner) return res.status(404).json({ error: '记忆不存在' });
  db.deleteMemory(req.params.id);
  notifyChanged();
  res.json({ success: true });
});

// 合并「主题重复」的记忆：保留信息最完整的一条，删除其余
app.post('/api/memories/merge', (req, res) => {
  const owner = ctrlOwner(req);
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String).slice(0, 20) : [];
  if (ids.length < 2) return res.status(400).json({ error: '至少选择两条记忆' });
  const kept = db.mergeMemories(owner, ids);
  if (!kept) return res.status(404).json({ error: '可合并的记忆不足' });
  notifyChanged();
  res.json({ memory: kept, removed: ids.length - 1 });
});

// 清理当前 owner 已到期的记忆
app.post('/api/memories/cleanup', (req, res) => {
  const owner = ctrlOwner(req);
  const removed = db.cleanupExpiredMemories(owner);
  notifyChanged();
  res.json({ success: true, removed });
});

app.put('/api/reminders/:id', (req, res) => {
  const owner = ctrlOwner(req);
  const rem = db.getReminderById(req.params.id);
  if (!rem || rem.owner !== owner) return res.status(404).json({ error: '待办不存在' });
  const { body, due_at } = req.body || {};
  const updated = db.updateReminder(req.params.id, {
    body: body !== undefined ? String(body) : undefined,
    due_at: due_at === undefined ? undefined : due_at === null || due_at === '' ? null : String(due_at),
  });
  if (!updated) return res.status(404).json({ error: '待办不存在' });
  notifyChanged();
  res.json({ reminder: updated });
});

app.delete('/api/reminders/:id', (req, res) => {
  const owner = ctrlOwner(req);
  const rem = db.getReminderById(req.params.id);
  if (!rem || rem.owner !== owner) return res.status(404).json({ error: '待办不存在' });
  db.deleteReminder(req.params.id);
  notifyChanged();
  res.json({ success: true });
});

// 全量设置某待办子步骤（模型建步骤 / 前端编辑步骤都走这）
app.put('/api/reminders/:id/steps', (req, res) => {
  const owner = ctrlOwner(req);
  const rem = db.getReminderById(req.params.id);
  if (!rem || rem.owner !== owner) return res.status(404).json({ error: '待办不存在' });
  const raw = Array.isArray(req.body?.steps) ? req.body.steps : [];
  const steps = raw
    .map((s: any) => (typeof s === 'string' ? { text: s } : { text: String(s?.text || ''), done: s?.done === 1 || s?.done === true ? 1 : 0 }))
    .filter((s: { text: string }) => s.text && s.text.trim());
  const updated = db.setReminderSteps(req.params.id, steps);
  if (!updated) return res.status(404).json({ error: '待办不存在' });
  notifyChanged();
  res.json({ reminder: updated });
});

// 勾选 / 取消某条子步骤（前端 checkbox 走这）
app.post('/api/reminders/:id/step/toggle', (req, res) => {
  const owner = ctrlOwner(req);
  const rem = db.getReminderById(req.params.id);
  if (!rem || rem.owner !== owner) return res.status(404).json({ error: '待办不存在' });
  const seq = Number(req.body?.seq);
  if (!Number.isFinite(seq)) return res.status(400).json({ error: 'seq 必须是数字' });
  const force = req.body?.done === undefined ? undefined : req.body.done === 1 || req.body.done === true ? 1 : 0;
  const updated = db.toggleReminderStep(req.params.id, seq, force === undefined ? undefined : force === 1);
  if (!updated) return res.status(404).json({ error: '待办或子步骤不存在' });
  notifyChanged();
  res.json({ reminder: updated });
});

// 完成 / 打卡一条提醒（周期提醒完成一期会自动生成下一期）
app.post('/api/reminders/:id/complete', (req, res) => {
  const owner = ctrlOwner(req);
  const rem = db.getReminderById(req.params.id);
  if (!rem || rem.owner !== owner) return res.status(404).json({ error: '待办不存在' });
  const ok = db.completeReminder(req.params.id);
  if (!ok) return res.status(404).json({ error: '待办不存在' });
  notifyChanged();
  res.json({ success: true });
});
}
