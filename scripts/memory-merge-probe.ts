// A2 验证：记忆冲突一键合并（保留信息最完整的一条，删除其余）。
// 运行前先起服务：MOCK_AGENT=1 PORT=3103 npx tsx server/index.ts
const BASE = process.env.BASE || 'http://127.0.0.1:3103';
const OWNER = 'guest';
const j = async (r: any) => ({ status: r.status, body: await r.json().catch(() => null) });
let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

const mk = (kind: string, key: string, value: string) =>
  fetch(`${BASE}/api/admin/memories`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ owner: OWNER, kind, key, value }) });

async function main() {
  // 建 3 条主题重复的记忆，信息完整度不同（最短 / 中等 / 最长）
  console.log('[1] 造三条重复记忆');
  const a = await j(await mk('sport', '喜欢的运动', '爬山'));
  const b = await j(await mk('sport', '喜欢的运动类型', '登山和徒步'));
  const c = await j(await mk('sport', '喜欢的运动类型偏好', '登山和徒步，尤其喜欢秋天去近郊，避开人流'));
  const ids = [a.body?.memory?.id, b.body?.memory?.id, c.body?.memory?.id].filter(Boolean);
  ok(ids.length === 3, '三条记忆创建成功');

  // 合并
  console.log('[2] 合并');
  const merged = await j(await fetch(`${BASE}/api/memories/merge?owner=${OWNER}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) }));
  ok(merged.status === 200, '合并接口返回 200');
  ok(merged.body?.removed === 2, `删除了 ${merged.body?.removed} 条重复`);
  ok(
    merged.body?.memory?.value === '登山和徒步，尤其喜欢秋天去近郊，避开人流',
    '保留了信息最完整的一条（value 最长）'
  );

  // 确认只剩一条
  console.log('[3] 确认结果');
  const ctx = await j(await fetch(`${BASE}/api/context?owner=${OWNER}`));
  const left = (ctx.body?.memories || []).filter((m: any) => ids.includes(m.id));
  ok(left.length === 1, `库里只剩 ${left.length} 条（应保留 1 条）`);
  ok(left[0]?.id === c.body?.memory?.id, '保留的正是信息最完整那条');

  // 清理
  console.log('[4] 清理');
  for (const id of [left[0]?.id].filter(Boolean)) {
    await fetch(`${BASE}/api/memories/${id}?owner=${OWNER}`, { method: 'DELETE' });
  }
  const ctx2 = await j(await fetch(`${BASE}/api/context?owner=${OWNER}`));
  const still = (ctx2.body?.memories || []).filter((m: any) => ids.includes(m.id));
  ok(still.length === 0, '测试记忆已清理');

  // 参数校验
  console.log('[5] 参数校验');
  const bad = await j(await fetch(`${BASE}/api/memories/merge?owner=${OWNER}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [] }) }));
  ok(bad.status === 400, '少于两条返回 400');
  const bad2 = await j(await fetch(`${BASE}/api/memories/merge?owner=${OWNER}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: ['x', 'y'] }) }));
  ok(bad2.status === 404, '不存在的 id 返回 404（不误删）');

  console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('探针异常：', e); process.exit(2); });
