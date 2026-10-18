// 清理 P1 探针（proactive-p1-probe.ts）在本机库里造的测试数据。
// 只删探针自己写入的内容：3 条记忆 / 1 条提醒 / 全部主动卡反馈信号。
import * as db from '../server/db.js';

const OWNER = 'guest';
const KEYS = ['作息', '本周目标', '沟通']; // 探针写入的记忆 key

function run() {
  const hit = db.getMemories(OWNER, 100).filter((m) => KEYS.includes(m.key));
  for (const m of hit) db.deleteMemory(m.id);
  console.log(`记忆：删除 ${hit.length} 条（${hit.map((m) => m.key).join('、') || '无'}）`);

  const rHit = db.listReminders(OWNER, true).filter((r: any) => r.body === 'P1 探针提醒');
  for (const r of rHit) db.deleteReminder(r.id);
  console.log(`提醒：删除 ${rHit.length} 条`);

  const del = db.clearProactiveFeedback(OWNER);
  console.log(`主动卡反馈：删除 ${del} 条`);

  console.log(`剩余：记忆 ${db.getMemories(OWNER, 100).length} 条 / 提醒 ${db.listReminders(OWNER, false).length} 条`);
}

run();
