/**
 * 清理 reminders 中的重复项（与运行时 db.addReminder 的去重逻辑保持一致）。
 * 两级判定：
 *   1) owner + 归一化 body + 归一化 due_at 完全相同
 *   2) 语义去重：归一化后做**前缀包含**判定（短的是长的前缀即视为同一条，短的至少 6 字）。
 *      注意不能只比「前 N 字符」：归一化会去掉括号，
 *      「出发去近郊轻出行（记得早出避人流）」的前 N 字会被后半段占据，跟「出发去近郊轻出行」匹配不上。
 * 每组保留**最早创建**的一条。
 * 用法：node scripts/dedupe-reminders.cjs
 */
const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, '../data/chat.db'));

const norm = (s) =>
  (s || '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。、！？,.!?~～·:：;；'"“”‘’()（）\-—_/\\]/g, '')
    .toLowerCase();

const SIM_HEAD_MIN = 6; // 与 server/db.ts 保持一致

const rows = db.prepare('SELECT * FROM reminders ORDER BY created_at ASC').all();
const kept = [];
const del = [];

for (const r of rows) {
  const nb = norm(r.body);
  const nd = norm(r.due_at);
  const hit = kept.find((k) => {
    if (k.owner !== r.owner) return false;
    // 1) 完全相同
    if (k.nb === nb && k.nd === nd) return true;
    // 2) 前缀包含 + 时间一致（或有一方没给时间）
    const short = k.nb.length <= nb.length ? k.nb : nb;
    const long = k.nb.length <= nb.length ? nb : k.nb;
    if (short.length < SIM_HEAD_MIN || !long.startsWith(short)) return false;
    return k.nd === nd || k.nd === '' || nd === '';
  });
  if (hit) del.push({ id: r.id, body: r.body, due_at: r.due_at });
  else kept.push({ owner: r.owner, nb, nd });
}

const stmt = db.prepare('DELETE FROM reminders WHERE id = ?');
for (const d of del) {
  console.log(`  删除重复：「${d.body}」${d.due_at ? `（${d.due_at}）` : ''}`);
  stmt.run(d.id);
}

console.log(`\n共删除 ${del.length} 条重复提醒`);
console.log('\n--- 保留的提醒 ---');
for (const r of db.prepare('SELECT body,due_at,done FROM reminders ORDER BY created_at').all()) {
  console.log(`  · ${r.body}${r.due_at ? `（${r.due_at}）` : ''}`);
}
db.close();
