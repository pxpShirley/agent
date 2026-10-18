/**
 * 星澜 · 服务入口（只做装配）
 *
 * 这个文件以前塞了 50 个路由、800 行；现在只负责：
 *   中间件 → 管理鉴权 → 启动数据/调度 → 挂载各域路由 → listen
 * 路由按域拆到 `server/routes/` 下，改某个域不用再在 800 行里翻找。
 */
import './env.js';
import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { createAdminAuth, ADMIN_TOKEN } from './adminAuth.js';
import { startScheduler } from './scheduler.js';
import { seedAll } from './seed.js';
import * as db from './db.js';

import { registerMeta } from './routes/meta.js';
import { registerContext } from './routes/context.js';
import { registerProactive } from './routes/proactive.js';
import { registerArtifacts } from './routes/artifacts.js';
import { registerSessions } from './routes/sessions.js';
import { registerChat } from './routes/chat.js';
import { registerUserData } from './routes/userData.js';
import { registerAdmin } from './routes/admin.js';
import { registerMusic } from './routes/music.js';

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.use(express.json({ limit: '2mb' }));

// 管理后台鉴权（可选）：设置 ADMIN_TOKEN 后，所有 /api/admin/* 受保护；
// 未设置则保持现状（开放）。token 可通过 query(?token=) / Cookie(admin_token) / Bearer 头提供。
app.use('/api/admin', createAdminAuth(ADMIN_TOKEN));

// 初始化演示数据
seedAll(false);

// 存量迁移：给只有 due_at 文本的老待办补上结构化的 due_ts（幂等）
try {
  const n = db.backfillDueTs();
  if (n) console.log(`[DB] backfill: reminders.due_ts 回填 ${n} 行`);
} catch (e) {
  console.warn('[DB] backfill due_ts 失败', e);
}

// 启动主动调度（晨报 / 到期提醒 / 周复盘）
startScheduler();

// 路由按域挂载
registerMeta(app);
registerContext(app);
registerProactive(app);
registerArtifacts(app);
registerSessions(app);
registerChat(app);
registerUserData(app);
registerAdmin(app);
registerMusic(app);

// 绑定到 127.0.0.1（localhost）：满足沙箱/受限环境对 0.0.0.0 的监听限制，
// 同时自用场景本就只在本机访问，不向外网暴露更稳妥。代理(/api → localhost:PORT)无需改动。
const HOST = process.env.HOST || '127.0.0.1';

// 单进程托管构建产物：dev 用 Vite 代理；这里让本服务直接 serving dist（静态资源 + SPA 回退），
// 同源下前端相对 /api 自然打到本服务，避开 dev 代理跨进程 / IPv4·IPv6 双栈的坑，演示即开即用。
const DIST_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
if (fs.existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(DIST_DIR, 'index.html'));
  });
  console.log(`[星澜] 已挂载静态资源: ${DIST_DIR}（同源托管前端）`);
}

app.listen(PORT, HOST, () => {
  console.log(`[星澜] 服务已启动: http://${HOST}:${PORT}`);
});
