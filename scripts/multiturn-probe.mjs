/**
 * 多轮上下文回归测试：在同一个会话里连发两轮，验证模型能否接住上文。
 * 场景取自用户真实反馈：先问假期怎么过，再说「设置一个提醒 我不想出门太远」。
 * 若模型回「提醒什么事？什么时候？」说明上下文没带过去（失忆）。
 */
const rounds = [
  '国庆假期就剩两天了 怎么愉快的度过最后两天呢',
  '设置一个提醒 我不想出门太远',
];

let sessionId;
for (const message of rounds) {
  const res = await fetch('http://localhost:3000/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(sessionId ? { sessionId, message } : { message }),
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
      if (d.type === 'init') sessionId = d.sessionId;
      if (d.type === 'text') acc += d.content || '';
      if (d.type === 'tool') tools.push(d.name);
    }
  }
  console.log(`\n===== 轮次：${message} =====`);
  console.log('工具：', tools.join(',') || '(无)');
  console.log(acc.trim());
}

// 失忆检测：第二轮是否还在空泛反问
console.log('\n===== 判定 =====');
