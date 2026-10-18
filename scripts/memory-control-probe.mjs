// 验证 P0 用户侧记忆/提醒管控端点（纯 DB 操作，不依赖 LLM 引擎）。
// 运行：npx tsx scripts/memory-control-probe.mjs  （需先起 server：MOCK_AGENT=1 PORT=3101 npx tsx server/index.ts）
const BASE = process.env.BASE || 'http://127.0.0.1:3101';
const OWNER = 'guest';
const j = async (r) => ({ status: r.status, body: await r.json().catch(() => null) });

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

// 1) 建两条相似记忆（主题相近，用于冲突检测演示）
console.log('[1] 创建两条记忆');
const m1 = await j(await fetch(`${BASE}/api/admin/memories`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ owner: OWNER, kind: 'sport', key: '喜欢的运动', value: '爬山' }) }));
const m2 = await j(await fetch(`${BASE}/api/admin/memories`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ owner: OWNER, kind: 'sport', key: '喜欢的运动类型', value: '登山徒步' }) }));
ok(m1.status === 200 && m1.body?.memory?.id, '记忆1 创建成功');
ok(m2.status === 200 && m2.body?.memory?.id, '记忆2 创建成功');

// 2) 编辑记忆1（改 value + 设未来过期时间）
console.log('[2] 编辑记忆（value + 过期时间）');
const edit = await j(await fetch(`${BASE}/api/memories/${m1.body.memory.id}?owner=${OWNER}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: '登山与徒步', expire_at: '2099-12-31' }) }));
ok(edit.status === 200 && edit.body?.memory?.value === '登山与徒步', '记忆1 value 已更新');
ok(edit.body?.memory?.expire_at?.startsWith('2099-12-31'), '记忆1 expire_at 已写入');

// 3) 设记忆2为已过期（过去时间），再清理
console.log('[3] 过期 + 清理');
const exp = await j(await fetch(`${BASE}/api/memories/${m2.body.memory.id}?owner=${OWNER}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expire_at: '2020-01-01' }) }));
ok(exp.status === 200, '记忆2 设为已过期');
const clean = await j(await fetch(`${BASE}/api/memories/cleanup?owner=${OWNER}`, { method: 'POST' }));
ok(clean.status === 200 && clean.body?.removed >= 1, `清理过期记忆 removed=${clean.body?.removed}`);

// 4) 确认记忆2已被删
console.log('[4] 确认过期记忆已消失');
const ctx1 = await j(await fetch(`${BASE}/api/context?owner=${OWNER}`));
const ids = (ctx1.body?.memories || []).map((x) => x.id);
ok(!ids.includes(m2.body.memory.id), '记忆2 不在上下文列表（已清理）');
ok(ids.includes(m1.body.memory.id), '记忆1 仍在（未过期）');

// 5) 删除记忆1
console.log('[5] 删除记忆1');
const del = await j(await fetch(`${BASE}/api/memories/${m1.body.memory.id}?owner=${OWNER}`, { method: 'DELETE' }));
ok(del.status === 200, '记忆1 删除请求成功');
const ctx2 = await j(await fetch(`${BASE}/api/context?owner=${OWNER}`));
ok(!(ctx2.body?.memories || []).map((x) => x.id).includes(m1.body.memory.id), '记忆1 已删除');

// 6) 提醒：编辑 + 删除（用既有 seed 提醒）
console.log('[6] 提醒编辑 + 删除');
const ctxR = await j(await fetch(`${BASE}/api/context?owner=${OWNER}`));
const rem = (ctxR.body?.reminders || [])[0];
ok(!!rem, '存在可操作的提醒');
if (rem) {
  const rEdit = await j(await fetch(`${BASE}/api/reminders/${rem.id}?owner=${OWNER}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: '探针临时改写的提醒', due_at: '2099-06-01' }) }));
  ok(rEdit.status === 200 && rEdit.body?.reminder?.body === '探针临时改写的提醒', '提醒内容已更新');
  const rDel = await j(await fetch(`${BASE}/api/reminders/${rem.id}?owner=${OWNER}`, { method: 'DELETE' }));
  ok(rDel.status === 200, '提醒删除成功');
  const ctxR2 = await j(await fetch(`${BASE}/api/context?owner=${OWNER}`));
  ok(!(ctxR2.body?.reminders || []).map((x) => x.id).includes(rem.id), '提醒已从列表移除');
}

// 7) 归属安全：用错误 owner 删除应 404
console.log('[7] 归属校验');
const fake = await j(await fetch(`${BASE}/api/memories/does-not-exist?owner=someone-else`, { method: 'DELETE' }));
ok(fake.status === 404, '错误 owner / 不存在 id 返回 404（不越权）');

console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
