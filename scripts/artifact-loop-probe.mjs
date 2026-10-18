/**
 * 「反复要求打开同一个产物」回归测试。
 * 历史 bug：用户连说 4 次「打开产物《X》」，模型每次都重新 create_artifact，
 * 刷出 7 张同名卡片，还自称「刚才其实没生成，是我表述太急」。
 * 期望：用 open_artifact 读取展示，产物数量不再增长。
 */
const rounds = ['打开产物《国庆最后两天·轻出行+收心蓄力》', '打开产物《国庆最后两天·轻出行+收心蓄力》'];

// 复用已有会话（库里最新的那个），确保产物确实存在
import Database from 'better-sqlite3';
const db = new Database('data/chat.db', { readonly: true });
const sessionId = db.prepare('SELECT id FROM sessions ORDER BY created_at DESC LIMIT 1').get().id;
const before = db.prepare('SELECT COUNT(*) c FROM artifacts').get().c;
console.log('会话 =', sessionId.slice(0, 8), '| 开始前产物数 =', before);
db.close();

for (const message of rounds) {
  const res = await fetch('http://localhost:3000/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, message }),
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let acc = '';
  const tools = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop() || '';
    for (const part of parts) {
      const line = part.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue;
      let d;
      try {
        d = JSON.parse(line.slice(6));
      } catch {
        continue;
      }
      if (d.type === 'text') acc += d.content || '';
      if (d.type === 'tool') tools.push(d.name);
    }
  }
  console.log(`\n===== ${message} =====`);
  console.log('工具：', tools.join(',') || '(无)');
  console.log(acc.trim().slice(0, 700));
}

const db2 = new Database('data/chat.db', { readonly: true });
const after = db2.prepare('SELECT COUNT(*) c FROM artifacts').get().c;
console.log('\n===== 判定 =====');
console.log('产物数：', before, '→', after, after === before ? '✅ 未重复创建' : `❌ 新增了 ${after - before} 张`);
