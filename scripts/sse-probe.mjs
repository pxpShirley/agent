/**
 * SSE 探针：直连 /api/chat，统计后端实际吐出的正文长度。
 * 用于定位「前端看到的正文 = 后端正文 ×2」这类重复问题究竟发生在服务端还是客户端。
 * 用法：node scripts/sse-probe.mjs "你的问题"
 */
const message = process.argv.slice(2).join(' ') || '用一句话说一下你现在用的是哪个大模型';

const res = await fetch('http://localhost:3000/api/chat', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ message }),
});
if (!res.ok) {
  console.log('HTTP', res.status);
  process.exit(1);
}
const reader = res.body.getReader();
const decoder = new TextDecoder();
let sseBuffer = '';
let textLen = 0;
let nText = 0;
let doneFull = null;
let acc = '';
const events = [];

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  sseBuffer += decoder.decode(value, { stream: true });
  const parts = sseBuffer.split('\n\n');
  sseBuffer = parts.pop() || '';
  for (const part of parts) {
    const line = part.split('\n').find((l) => l.startsWith('data: '));
    if (!line) continue;
    let d;
    try {
      d = JSON.parse(line.slice(6));
    } catch {
      continue;
    }
    events.push(d.type);
    if (d.type === 'text') {
      nText++;
      textLen += (d.content || '').length;
      acc += d.content || '';
    }
    if (d.type === 'done') doneFull = d.fullText;
    if (d.type === 'notice') console.log('[notice]', d.level || '', d.message || '');
    if (d.type === 'done') console.log('[done]', JSON.stringify({ ...d, fullText: undefined }));
  }
}

console.log('事件序列 =', events.join(','));
console.log('text 事件数 =', nText, '| 累加正文长度 =', textLen);
console.log('done.fullText 长度 =', doneFull == null ? '(后端未下发)' : doneFull.length);
console.log('--- 正文 ---');
console.log(acc);
console.log('--- 结束 ---');
// 服务端是否自我重复：检测正文里是否出现长度 >= 30 的重复片段
const half = Math.floor(acc.length / 2);
let dup = false;
for (let win = 40; win <= half; win += 20) {
  const a = acc.slice(0, win);
  if (acc.slice(win).includes(a)) {
    dup = true;
    console.log(`❌ 检测到自我重复：开头 ${win} 字片段在正文中再次出现`);
    break;
  }
}
console.log(dup ? '' : '✅ 服务端无重复（与 done.fullText 一致性不适用时以累加为准）');
