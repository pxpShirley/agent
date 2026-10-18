// E2E 记忆闭环探针（mock 模式，不依赖大模型 Key）
// 1) 向 /api/chat 发送一条"透露偏好/习惯"的消息
// 2) 直接读 DB，确认该 owner 下已落库 memories（验证 save→持久化→下一轮可被 buildMemoryContext 注入）
import { randomUUID } from 'node:crypto';

const BASE = process.env.BASE || 'http://localhost:3000';
const OWNER = 'probe_user_' + Date.now();
const SID = randomUUID();

const msg = '我习惯晚上11点之后尽量少被打扰，而且我特别喜欢爬山，周末经常去近郊。';

async function main() {
  const resp = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: SID, message: msg, customerName: OWNER }),
  });
  if (!resp.ok) throw new Error('chat http ' + resp.status);
  // 消费 SSE 流（我们只关心落库副作用）
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
  }
  console.log('[chat] 流式已消费，字节数', buf.length);

  // 直接读 DB 验证落库
  const { getMemories } = await import('../server/db.ts');
  const mem = getMemories(OWNER, 50);
  console.log('[db] 该 owner 记忆条数:', mem.length);
  for (const m of mem) console.log('   -', `[${m.kind}]`, m.key, '=', m.value);

  const ok = mem.length > 0;
  console.log(ok ? '\n✅ 记忆闭环（透露→落库）验证通过' : '\n❌ 未落库');
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
