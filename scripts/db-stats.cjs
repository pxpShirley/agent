const D = require('better-sqlite3');
const d = new D('data/chat.db', { readonly: true });

const tables = ['sessions', 'messages', 'memories', 'reminders', 'moods', 'agent_runs', 'overrides', 'pending_questions', 'proactive_cards', 'artifacts'];
console.log('=== 表行数 ===');
for (const t of tables) {
  try {
    const n = d.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
    console.log(`${t.padEnd(20)} ${n}`);
  } catch (e) {
    console.log(`${t.padEnd(20)} (missing)`);
  }
}

console.log('\n=== memories 明细（按长度倒序）===');
try {
  const rows = d.prepare('SELECT id, owner, kind, key, length(value) len, substr(value,1,60) head FROM memories ORDER BY len DESC LIMIT 15').all();
  for (const r of rows) console.log(`[${r.len}] ${r.kind}/${r.key}: ${r.head}`.slice(0, 160));
} catch (e) { console.log('err', e.message); }

console.log('\n=== reminders 前 10 ===');
try {
  for (const r of d.prepare('SELECT id, owner, substr(body,1,50) body, done FROM reminders LIMIT 10').all()) console.log(`${r.done ? '[done]' : '[open]'} ${r.body}`);
} catch (e) { console.log('err', e.message); }

console.log('\n=== sessions 前 10 ===');
try {
  for (const r of d.prepare('SELECT id, substr(title,1,30) t, customer_name FROM sessions LIMIT 10').all()) console.log(`${r.id.slice(0, 8)} ${r.t} (${r.customer_name})`);
} catch (e) { console.log('err', e.message); }

d.close();
