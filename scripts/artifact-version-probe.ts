// P2·活产物 A1 验证：产物版本历史与回滚。
// 运行前先起服务：MOCK_AGENT=1 PORT=3103 npx tsx server/index.ts
const BASE = process.env.BASE || 'http://127.0.0.1:3103';
const j = async (r: any) => ({ status: r.status, body: await r.json().catch(() => null) });
let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

async function main() {
  // 取一个既有产物来测（没有则先用管家生成一个）
  const list = await j(await fetch(`${BASE}/api/artifacts?owner=guest`));
  const arts = list.body?.artifacts || [];
  const artId = arts.length ? arts[0].id : '';
  ok(!!artId, `取到可测产物（列表 ${arts.length} 条）`);
  if (!artId) { console.log('\n无产物可测，先让管家生成一个再跑'); process.exit(1); }

  const before = (await j(await fetch(`${BASE}/api/artifacts/${artId}`))).body?.artifact;
  const v0 = before?.version;
  const c0 = before?.content;
  console.log(`  起始：v${v0}`);

  // 1) 改内容 → 应产生快照
  console.log('[1] 编辑自动快照');
  await fetch(`${BASE}/api/artifacts/${artId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: '第一版改动内容' }) });
  const v1 = await j(await fetch(`${BASE}/api/artifacts/${artId}/versions`));
  ok(v1.status === 200, '版本列表接口可用');
  const vers1 = v1.body?.versions || [];
  ok(vers1.length >= 1, `编辑后产生 ${vers1.length} 条历史版本`);
  ok(vers1.some((v: any) => v.content === c0), '历史里保留了改动前的内容');
  ok(vers1.some((v: any) => v.version === v0), `快照版本号 = 改动前的 v${v0}`);

  // 2) 再改一次 → 快照累计
  console.log('[2] 多次编辑累计快照');
  await fetch(`${BASE}/api/artifacts/${artId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: '第二版改动内容' }) });
  const v2 = await j(await fetch(`${BASE}/api/artifacts/${artId}/versions`));
  const vers2 = v2.body?.versions || [];
  ok(vers2.length > vers1.length, `快照累计到 ${vers2.length} 条（同一版本不重复快照）`);

  // 3) 回滚到最早那版
  console.log('[3] 回滚');
  const oldest = vers2[vers2.length - 1];
  const cur = (await j(await fetch(`${BASE}/api/artifacts/${artId}`))).body?.artifact;
  ok(cur?.content === '第二版改动内容', '回滚前内容 = 第二版');
  const rest = await j(await fetch(`${BASE}/api/artifacts/${artId}/restore`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ versionId: oldest.id }) }));
  ok(rest.status === 200, '回滚请求成功');
  const after = (await j(await fetch(`${BASE}/api/artifacts/${artId}`))).body?.artifact;
  ok(after?.content === oldest.content, `内容已恢复到 v${oldest.version}`);
  ok(after?.version > cur?.version, `回滚后 version 自增（${cur?.version} → ${after?.version}）`);

  // 4) 回滚本身不丢内容：回滚前的状态应被快照
  const v3 = await j(await fetch(`${BASE}/api/artifacts/${artId}/versions`));
  const vers3 = v3.body?.versions || [];
  ok(vers3.some((v: any) => v.content === '第二版改动内容'), '回滚前的「第二版」也被存为历史（不会丢内容）');

  // 5) 参数校验
  console.log('[4] 参数校验');
  const bad = await j(await fetch(`${BASE}/api/artifacts/${artId}/restore`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) }));
  ok(bad.status === 400, '缺 versionId 返回 400');
  const bad2 = await j(await fetch(`${BASE}/api/artifacts/nonexistent/versions`));
  ok(bad2.status === 404, '不存在产物返回 404');

  console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('探针异常：', e); process.exit(2); });
