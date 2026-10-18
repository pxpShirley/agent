// P1 验证：记忆驱动的主动个性化 + 免打扰时段 + 主动卡反馈学习闭环。
// 同时做 (A) 单元级免打扰解析 + (B) 经真实后端验证晨报个性化与反馈闭环。
// 运行前先起服务：MOCK_AGENT=1 PORT=3102 npx tsx server/index.ts
import { detectQuietHours, isQuietNow } from '../server/scheduler.js';
import * as db from '../server/db.js';

const BASE = process.env.BASE || 'http://127.0.0.1:3102';
const OWNER = 'guest';
const j = async (r: Response) => ({ status: r.status, body: await r.json().catch(() => null) });
let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

async function main() {
  // ===== (A) 免打扰时段解析（单元） =====
  console.log('[A] 免打扰时段解析');
  db.saveMemory(OWNER, 'preference', '作息', '习惯晚上11点后少打扰');
  const qh = detectQuietHours(OWNER);
  ok(!!qh && qh.start === 23, `解析出免打扰起点 ${JSON.stringify(qh)}`);
  ok(isQuietNow(qh, 23) === true, '23 点处于免打扰');
  ok(isQuietNow(qh, 9) === false, '上午 9 点不处于免打扰');
  ok(isQuietNow(null, 23) === false, '无免打扰记忆时任何时刻都不抑制');

  // ===== (B) 记忆驱动的晨报个性化 =====
  console.log('[B] 记忆驱动的晨报');
  // 清掉 guest 既有 morning 卡，允许重新生成
  const before = await j(await fetch(`${BASE}/api/proactive?owner=${OWNER}`));
  for (const c of before.body?.cards || []) {
    if (c.kind === 'morning') await fetch(`${BASE}/api/proactive/${c.id}/dismiss`, { method: 'POST' });
  }
  // 写入一条「计划」类记忆（pickBriefMemory 应优先选它）+ 一条偏好
  db.saveMemory(OWNER, 'plan', '本周目标', '本周完成季度复盘报告');
  db.saveMemory(OWNER, 'preference', '沟通', '喜欢先给结论，不喜欢被反复追问');
  // 确保有未完成提醒（activeOwners 需要 score>0）
  if (db.listReminders(OWNER, false).length === 0) db.addReminder(OWNER, 'P1 探针提醒', new Date(Date.now() + 36e5).toISOString());

  await fetch(`${BASE}/api/admin/scheduler/run`, { method: 'POST' });
  const after = await j(await fetch(`${BASE}/api/proactive?owner=${OWNER}`));
  const morning = (after.body?.cards || []).find((c: any) => c.kind === 'morning');
  ok(!!morning, '调度后生成了今日晨报');
  ok(!!morning && /季度复盘报告/.test(morning.body), '晨报引用了「计划」类记忆（而非只念第一条）');
  ok(!!morning && /先给结论|反复追问/.test(morning.body), '晨报带上了偏好记忆（计划 + 偏好都织入）');

  // ===== (C1) seen / dismissed 各记一条信号 =====
  console.log('[C] 主动卡反馈学习');
  const cards = (await j(await fetch(`${BASE}/api/proactive?owner=${OWNER}`))).body?.cards || [];
  const c1 = cards.find((c: any) => c.kind === 'reminder_due') || cards[0];
  const c2 = cards.find((c: any) => c.id !== c1?.id);
  if (c1) await fetch(`${BASE}/api/proactive/${c1.id}/seen`, { method: 'POST' });
  if (c2) await fetch(`${BASE}/api/proactive/${c2.id}/dismiss`, { method: 'POST' });
  const fb = await j(await fetch(`${BASE}/api/proactive/feedback?owner=${OWNER}`));
  ok(fb.status === 200, '反馈接口可用');
  if (c1) ok(fb.body?.feedback?.[c1.kind]?.seen >= 1, `seen 信号已记录（${c1.kind}）`);
  if (c2) ok(fb.body?.feedback?.[c2.kind]?.dismissed >= 1, `dismissed 信号已记录（${c2.kind}）`);

  // ===== (C2) 连划 2 张「到期提醒」→ 摘要应给出"更克制" =====
  const rdCards = (await j(await fetch(`${BASE}/api/proactive?owner=${OWNER}`))).body?.cards || [];
  const two = rdCards.filter((c: any) => c.kind === 'reminder_due').slice(0, 2);
  for (const c of two) await fetch(`${BASE}/api/proactive/${c.id}/dismiss`, { method: 'POST' });
  const fb2 = await j(await fetch(`${BASE}/api/proactive/feedback?owner=${OWNER}`));
  ok(two.length >= 2, `取到 ${two.length} 张到期提醒卡用于连划`);
  ok(!!fb2.body?.summary && /更克制/.test(fb2.body.summary), `反馈摘要生效：${fb2.body?.summary}`);

  // ===== (C3) 重新生成晨报，确认摘要被织入（越用越懂你） =====
  const cur = (await j(await fetch(`${BASE}/api/proactive?owner=${OWNER}`))).body?.cards || [];
  for (const c of cur.filter((c: any) => c.kind === 'morning')) await fetch(`${BASE}/api/proactive/${c.id}/dismiss`, { method: 'POST' });
  await fetch(`${BASE}/api/admin/scheduler/run`, { method: 'POST' });
  const after2 = await j(await fetch(`${BASE}/api/proactive?owner=${OWNER}`));
  const morning2 = (after2.body?.cards || []).find((c: any) => c.kind === 'morning');
  ok(!!morning2 && /更克制/.test(morning2.body), '晨报里出现了反馈学习摘要（越用越懂你）');

  console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('探针异常：', e); process.exit(2); });
