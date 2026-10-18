import type { Express } from 'express';
import * as db from '../db.js';
import { notifyChanged } from '../realtime.js';
import { ctrlOwner, serializeMessage } from './shared.js';

export function registerContext(app: Express): void {
// 管家上下文：跨会话聚合「了解你 / 待办 / 情绪」，供前端「管家此刻」面板真实读取
app.get('/api/context', (_req, res) => {
  const owner = (String(_req.query.owner || '') || 'guest').slice(0, 64);
  res.json({
    owner,
    memories: db.getMemories(owner, 30),
    reminders: db.listReminders(owner, false),
    moods: db.recentMoods(owner, 14),
  });
});
// 此刻主页聚合：主动事项 + 待你确认 + 进行中（最近行动）+ 一句话建议
app.get('/api/now', (req, res) => {
  const owner = (String(req.query.owner || '') || 'guest').slice(0, 64);
  const since = new Date(Date.now() - 86400000).toISOString();
  const proactive = db.getProactive(owner);
  const pending = db.getOpenPending(owner);
  const inProgress = db.getAgentRuns(10).filter((r) => r.created_at >= since);
  const suggestions = [
    '记一下明早 8 点跑步',
    '帮我规划一次杭州周末周边游',
    '查一下本周末天气',
    '今天有点累，陪我聊聊',
    '帮我理一下本周计划',
  ];
  res.json({ owner, proactive, pending, inProgress, suggestions });
});
}
