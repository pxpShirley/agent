// 人在环闭环探针（mock 模式）：发高风险消息 → 应触发 ask_user → 确认 cancel → 落库 cancelled
import { randomUUID } from 'node:crypto';

const BASE = process.env.BASE || 'http://localhost:3000';
const OWNER = 'probe_human_' + Date.now();
const SID = randomUUID();

async function postChat(message) {
  const resp = await fetch(`${BASE}/api/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: SID, message, customerName: OWNER }),
  });
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '', askId = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    for (const line of buf.split('\n')) {
      if (line.startsWith('data: ')) {
        try {
          const ev = JSON.parse(line.slice(6));
          if (ev.type === 'ask_user') askId = ev.id;
        } catch {}
      }
    }
  }
  return askId;
}

async function confirm(id, decision) {
  const resp = await fetch(`${BASE}/api/chat/confirm`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, decision }),
  });
  return resp.json();
}

async function main() {
  const askId = await postChat('帮我发微信给张三：今晚老地方吃饭');
  console.log('[chat] ask_user id:', askId);
  if (!askId) { console.log('❌ 未触发 ask_user'); process.exit(1); }

  const res = await confirm(askId, 'cancel');
  console.log('[confirm] decision=cancel ->', JSON.stringify(res).slice(0, 160));

  const { getPendingQuestion } = await import('../server/db.ts');
  const pq = getPendingQuestion(askId);
  console.log('[db] pending status:', pq?.status);
  const ok = pq?.status === 'cancelled';
  console.log(ok ? '\n✅ 人在环闭环验证通过（ask_user→确认→落库 cancelled）' : '\n❌ 闭环异常');
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
