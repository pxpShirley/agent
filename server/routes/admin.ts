import type { Express } from 'express';
import { seedAll } from '../seed.js';
import { runSchedulerNow } from '../scheduler.js';
import { webSearch } from '../tools/web.js';
import { subscribeChange } from '../realtime.js';
import { ADMIN_TOKEN } from '../adminAuth.js';
import * as db from '../db.js';
import { notifyChanged } from '../realtime.js';
import { ctrlOwner, serializeMessage } from './shared.js';
import { exportMemoryMarkdown } from '../memory.js';
import { TRACE_VIEWER_HTML } from '../traceViewer.js';

export function registerAdmin(app: Express): void {
app.get('/api/admin/stats', (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 14, 1), 90);
  res.json(db.getStats(days));
});

app.get('/api/admin/conversations', (req, res) => {
  const rows = db.listConversations({
    keyword: (req.query.keyword as string) || '',
    intent: (req.query.intent as string) || 'all',
    status: (req.query.status as string) || 'all',
  });
  res.json({ conversations: rows });
});

app.get('/api/admin/conversations/:id', (req, res) => {
  const session = db.getSession(req.params.id);
  if (!session) return res.status(404).json({ error: '会话不存在' });
  res.json({
    session,
    messages: db.getMessagesBySession(session.id).map(serializeMessage),
  });
});

// 记忆治理（运营侧，跨用户全量）：呈现 agent 真正写入的记忆/待办/心情
app.get('/api/admin/memories', (_req, res) => {
  res.json({ memories: db.listAllMemories() });
});

// P1（2026-10-24）记忆可检视导出：按 kind 分组渲染 Markdown，等价于 OpenClaw 的纯文件可读记忆。
// 运营/调试可一眼看清管家记住了关于用户的什么；?owner= 指定用户，缺省 guest。
app.get('/api/admin/memory/export', (req, res) => {
  const owner = (req.query.owner as string) || 'guest';
  const rows = db.getMemories(owner, 500);
  res.type('text/markdown').send(exportMemoryMarkdown(rows));
});
app.get('/api/admin/reminders', (_req, res) => {
  res.json({ reminders: db.listAllReminders() });
});
app.get('/api/admin/moods', (_req, res) => {
  res.json({ moods: db.listAllMoods() });
});
app.delete('/api/admin/memories/:id', (req, res) => {
  const ok = db.deleteMemory(req.params.id);
  if (!ok) return res.status(404).json({ error: '记忆不存在' });
  res.json({ success: true });
});
app.delete('/api/admin/reminders/:id', (req, res) => {
  const ok = db.deleteReminder(req.params.id);
  if (!ok) return res.status(404).json({ error: '待办不存在' });
  res.json({ success: true });
});
app.patch('/api/admin/reminders/:id', (req, res) => {
  const { action } = req.body || {};
  if (action === 'complete') {
    const ok = db.completeReminder(req.params.id);
    if (!ok) return res.status(404).json({ error: '待办不存在' });
    return res.json({ success: true });
  }
  res.status(400).json({ error: '未知操作' });
});

app.post('/api/admin/seed', (req, res) => {
  const force = Boolean(req.body?.force);
  if (force) db.clearConversations();
  const result = seedAll(force);
  res.json({ success: true, ...result });
});

// 主动卡片（运营侧全量）
app.get('/api/admin/proactive', (_req, res) => {
  res.json({ cards: db.listAllProactive() });
});
// 手动触发一轮主动调度（便于演示/排查，无需等待定时）
app.post('/api/admin/scheduler/run', async (_req, res) => {
  try {
    const result = await runSchedulerNow();
    res.json({ success: true, ...result });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || '调度失败' });
  }
});

// 验证 web_lookup 后端（沙箱无外网时优雅降级返回 error，不崩溃）
app.get('/api/admin/web-lookup', async (req, res) => {
  const q = String(req.query.q || '').slice(0, 200);
  if (!q) return res.status(400).json({ error: '缺少 q 参数' });
  const r = await webSearch(q, { limit: 5 });
  res.json(r);
});

app.post('/api/admin/reset-conversations', (_req, res) => {
  db.clearConversations();
  res.json({ success: true });
});

// 用户画像：跨会话聚合「了解你的用户」
app.get('/api/admin/portrait', (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 90);
  res.json(db.getPortrait(days));
});

// 轻量活动轮询：用于工作台实时刷新（新对话）
app.get('/api/admin/activity', (_req, res) => {
  const { sessions } = db.getActivity();
  res.json({ sessions, ts: Date.now() });
});

// 前端据此判断是否需输入令牌（本身不受 adminAuth 拦截）
app.get('/api/admin/auth-required', (_req, res) => {
  res.json({ required: Boolean(ADMIN_TOKEN) });
});

// 指挥舱实时流：后端数据变更时推送 `change` 信号，前端收到即重新拉取（带心跳保活）
app.get('/api/admin/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  const push = () => res.write('data: {"type":"change"}\n\n');
  push(); // 连接即推一次，前端立即拉首屏
  const unsub = subscribeChange(push);
  const hb = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(hb);
    unsub();
  });
});

// ============================================================
// 指挥舱（Command Deck）：活动流 + 例外收件箱 + 记忆即配置
// ============================================================
// 活动流：agent 真实执行过的动作遥测
app.get('/api/admin/runs', (_req, res) => {
  res.json({ runs: db.getAgentRuns(50) });
});

// 主循环观测（L0+ ②）：平均迭代次数 / 工具调用数 / 并发轮次 / 耗时。
// 优化（并行执行、记忆预注入）到底有没有省轮次，靠这个数字说话，不靠感觉。
app.get('/api/admin/loop-stats', (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
  res.json(db.getLoopStats(limit));
});

// 回放级 trace（P0·2026-10-25）：取一次对话轮的 span 序列（按 seq 有序），只读。
// 用于验证 F2/F3 主动时机是否真触发、模型每轮到底调了什么工具。
// ⚠️ 红线：该接口只对外暴露观测数据，绝不回灌模型上下文。
app.get('/api/admin/runs/:id/trace', (req, res) => {
  const run = db.getAgentRunById(req.params.id);
  if (!run) return res.status(404).json({ error: '运行记录不存在' });
  res.json({ run, spans: db.getRunTrace(run.id) });
});

// 回放查看器页面（自包含只读 HTML）：浏览器直接打开即可回放任意一轮
app.get('/api/admin/trace', (_req, res) => {
  res.type('text/html').send(TRACE_VIEWER_HTML);
});

// 例外收件箱：待人工确认的高风险动作（人在环 ask_user 闭环的待办侧）
app.get('/api/admin/pending', (req, res) => {
  const owner = (req.query.owner as string) || undefined;
  res.json({ questions: db.getOpenPending(owner) });
});

// 记忆即配置：直接教星澜记住一件事（运营侧写入，等价于对话里说的"记住…"）
app.post('/api/admin/memories', (req, res) => {
  const { owner = 'guest', kind = 'note', key, value } = req.body || {};
  if (!key || !value) {
    res.status(400).json({ error: '缺少 key 或 value' });
    return;
  }
  const row = db.saveMemory(String(owner), String(kind), String(key), String(value));
  notifyChanged();
  res.json({ memory: row });
});
}
