/**
 * 星澜 · 数据层门面
 *
 * 以前这里是一个 1299 行的单体文件（连接 + 12 张表的 DDL + 65 个函数）。
 * 现在按领域拆到 `server/db/` 下，本文件只做**再导出**——
 * 这样业务侧 `import * as db from './db.js'` 完全不用改，拆分对调用方零侵入。
 *
 * 领域划分：
 *   core          连接 / DDL / 迁移 / 公共类型
 *   conversations 会话与消息 / 统计 / 画像
 *   memories      长期记忆
 *   reminders     提醒与待办（含到期时间结构化）
 *   moods         情绪打卡
 *   artifacts     产物与版本历史
 *   proactive     主动卡片与反馈学习
 *   ops           遥测 / 待确认项 / 运营侧全量查询
 */
export * from './db/core.js';
export * from './db/conversations.js';
export * from './db/memories.js';
export * from './db/reminders.js';
export * from './db/moods.js';
export * from './db/artifacts.js';
export * from './db/proactive.js';
export * from './db/ops.js';
export * from './db/music.js';

import { db } from './db/core.js';
export default db;
