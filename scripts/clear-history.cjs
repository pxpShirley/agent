/**
 * 清空历史数据（会话/消息/记忆/提醒/情绪/活动流/待确认/主动卡/产物）。
 * 用法：node scripts/clear-history.cjs
 * 注意：建议先停后端再执行，避免并发写入。执行后不可恢复。
 */
const D = require('better-sqlite3');
const d = new D('data/chat.db');

const TABLES = [
  'messages',
  'sessions',
  'memories',
  'reminders',
  'moods',
  'agent_runs',
  'pending_questions',
  'proactive_cards',
  'artifacts',
];

const count = (t) => {
  try { return d.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c; } catch { return -1; }
};

console.log('=== 清空前 ===');
for (const t of TABLES) console.log(`${t.padEnd(20)} ${count(t)}`);

d.exec('BEGIN');
try {
  for (const t of TABLES) d.exec(`DELETE FROM ${t}`);
  d.exec('COMMIT');
} catch (e) {
  d.exec('ROLLBACK');
  console.error('清空失败：', e.message);
  process.exit(1);
}

// 重置自增（如存在）并回收空间
try { d.exec("DELETE FROM sqlite_sequence WHERE name IN ('messages','memories','reminders','agent_runs','artifacts')"); } catch { /* 无该表则忽略 */ }
try { d.exec('VACUUM'); } catch (e) { console.log('VACUUM 跳过：', e.message); }

console.log('\n=== 清空后 ===');
for (const t of TABLES) console.log(`${t.padEnd(20)} ${count(t)}`);
console.log('\n历史数据已清空。');
d.close();
