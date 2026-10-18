import type { Express } from 'express';
import * as db from '../db.js';
import { notifyChanged } from '../realtime.js';
import { ctrlOwner, serializeMessage } from './shared.js';

export function registerArtifacts(app: Express): void {
// 产物（Artifact）：结构化、可编辑、可分享的交付对象
app.get('/api/artifacts', (req, res) => {
  const owner = (String(req.query.owner || '') || 'guest').slice(0, 64);
  res.json({ artifacts: db.getArtifacts(owner) });
});
app.get('/api/artifacts/:id', (req, res) => {
  const a = db.getArtifact(req.params.id);
  if (!a) return res.status(404).json({ error: '产物不存在' });
  res.json({ artifact: a });
});
app.post('/api/artifacts/:id', (req, res) => {
  const { title, content, type } = req.body || {};
  const ok = db.updateArtifact(req.params.id, {
    title: typeof title === 'string' ? title : undefined,
    content: typeof content === 'string' ? content : undefined,
    type: typeof type === 'string' ? (type as any) : undefined,
  });
  if (!ok) return res.status(404).json({ error: '产物不存在' });
  notifyChanged();
  res.json({ success: ok });
});

// 产物版本历史（P2 活产物）：查看历史版本 / 回滚到某一版
app.get('/api/artifacts/:id/versions', (req, res) => {
  if (!db.getArtifact(req.params.id)) return res.status(404).json({ error: '产物不存在' });
  res.json({ versions: db.listArtifactVersions(req.params.id) });
});
app.post('/api/artifacts/:id/restore', (req, res) => {
  const versionId = String(req.body?.versionId || '');
  if (!versionId) return res.status(400).json({ error: '缺少 versionId' });
  const updated = db.restoreArtifactVersion(req.params.id, versionId);
  if (!updated) return res.status(404).json({ error: '版本或产物不存在' });
  notifyChanged();
  res.json({ artifact: updated });
});
}
