/**
 * 回归探针：到期时间（due_ts）结构化 + 能力清单同源
 *
 * 背景（2026-10-06 架构审计 A1/A2）：
 * - A1 曾经 `due_at` 存模型自由文本（`'10月7日 晚上 22:30'`），SQL 字符串比较误报未来的、
 *   漏报中文开头的，`new Date()` 全 NaN → 到期/逾期判定全线失效。
 * - A2 曾经提示词里的能力清单取自 `tools/index.ts`，与实际下发的 tools 数组不同源。
 *
 * 运行：npx tsx scripts/due-parse-probe.ts
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmp = path.join(os.tmpdir(), `due-probe-${Date.now()}.db`);
process.env.CHAT_DB_PATH = tmp;

const { parseDue } = await import('../server/due.js');
const db = await import('../server/db.js');

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} ${extra}`);
  }
};

// 固定基准：2026-10-06 14:50（周二）
const REF = new Date(2026, 9, 6, 14, 50, 0, 0);
const fmt = (ts: number | null) => (ts === null ? 'null' : new Date(ts).toString().slice(0, 24));

console.log('\n[1] parseDue 解析');
const cases: Array<[string | null, string | null]> = [
  ['2026-10-07 22:30', 'Wed Oct 07 2026 22:30:00'],
  ['2026-10-07T14:30:00.000Z', 'Wed Oct 07 2026 22:30:00'], // ISO（UTC+8 本地展示）
  ['明天 9 点', 'Wed Oct 07 2026 09:00:00'],
  ['后天 9 点', 'Thu Oct 08 2026 09:00:00'],
  ['今天 20:00', 'Tue Oct 06 2026 20:00:00'],
  ['10月7日 晚上 22:30', 'Wed Oct 07 2026 22:30:00'],
  ['10月6日 早上 8:30', 'Tue Oct 06 2026 08:30:00'],
  ['10月8日', 'Thu Oct 08 2026 09:00:00'], // 有日期没时刻 → 默认 9 点
  ['晚上 8:30', 'Tue Oct 06 2026 20:30:00'], // 12 → 24 小时制
  ['22:30', 'Tue Oct 06 2026 22:30:00'], // 只有时刻，今天还没到
  ['8:30', 'Wed Oct 07 2026 08:30:00'], // 只有时刻且已过 → 顺延明天
  ['明天下午3点', 'Wed Oct 07 2026 15:00:00'],
  ['周末 10 点', 'Sat Oct 10 2026 10:00:00'], // 周末 → 最近一个周六
  ['最后一天 22:30', null], // 无法解析 → 绝不瞎猜
  ['', null],
  [null, null],
];
for (const [input, expect] of cases) {
  const got = parseDue(input, REF);
  const label = `"${input}"`;
  if (expect === null) {
    ok(`${label} → null（不编造日期）`, got === null, `实际 ${fmt(got)}`);
  } else {
    ok(`${label} → ${expect}`, fmt(got) === expect, `实际 ${fmt(got)}`);
  }
}

console.log('\n[2] 写入即结构化：addReminder 落 due_ts');
const future = db.addReminder('t1', '明天交周报', '明天 9 点');
ok('未来提醒有 due_ts', typeof future.due_ts === 'number', String(future.due_ts));
ok('原文保留在 due_at', future.due_at === '明天 9 点');

const past = db.addReminder('t1', '昨天该做的事', '10月1日 9 点');
ok('过去提醒有 due_ts', typeof past.due_ts === 'number');

const vague = db.addReminder('t1', '最后一天早点睡', '最后一天 22:30');
ok('不可解析 → due_ts 为 null（不会误触发）', vague.due_ts === null, String(vague.due_ts));
ok('不可解析仍保留原文', vague.due_at === '最后一天 22:30');

console.log('\n[3] listDueReminders 只认 due_ts');
const due = db.listDueReminders('t1').map((r) => r.id);
ok('已过去的那条被判为到期', due.includes(past.id));
ok('未来的那条**不**被判为到期（修复前会误报）', !due.includes(future.id));
ok('不可解析的那条**不**被判为到期', !due.includes(vague.id));

console.log('\n[4] updateReminder 改时间会重算 due_ts');
db.updateReminder(future.id, { due_at: '10月1日 8:00' });
const moved = db.getReminderById(future.id)!;
ok('due_ts 跟随新时间重算', moved.due_ts !== null && moved.due_ts < REF.getTime() - 86400000, fmt(moved.due_ts));
ok('改后进入到期列表', db.listDueReminders('t1').some((r) => r.id === future.id));
db.updateReminder(future.id, { body: '明天交周报（改）' });
const bodyOnly = db.getReminderById(future.id)!;
ok('只改正文不动 due_ts', bodyOnly.due_ts === moved.due_ts);

console.log('\n[5] backfillDueTs 回填存量');
db.getReminderById(past.id);
const raw = db as any;
// 手工把一条的 due_ts 抹掉，模拟迁移前的老数据
raw.default.prepare('UPDATE reminders SET due_ts = NULL WHERE id = ?').run(vague.id);
const before = db.getReminderById(vague.id)!;
ok('模拟老数据 due_ts 为空', before.due_ts === null);
const n = db.backfillDueTs();
ok('backfill 只回填能解析的行', n >= 0);
ok('不可解析的行回填后仍为 null', db.getReminderById(vague.id)!.due_ts === null);
ok('backfill 幂等（再跑一次不报错）', typeof db.backfillDueTs() === 'number');

console.log('\n[6] A2 能力清单同源');
const { buildSystemPrompt } = await import('../server/agent.js');
const { activeToolDefs, execTool, ALL_TOOL_NAMES } = await import('../server/tools/registry.js');
const toolNames = activeToolDefs('t1').map((t: { name: string }) => t.name);
const prompt = buildSystemPrompt('（记忆）', toolNames);
ok('提示词包含 open_artifact（修复前缺失）', prompt.includes('- open_artifact'));
ok('提示词包含 create_artifact', prompt.includes('- create_artifact'));
ok('提示词包含 update_artifact', prompt.includes('- update_artifact'));
ok('提示词不含运行时没有的 xinglan', !/- xinglan/.test(prompt));
const listed = prompt
  .split('你当前可用的能力')[1]
  .split('注意：能力是分层供给的')[0]
  .split('\n')
  .slice(1) // 去掉标题行剩下的「（已按需要加载…）」说明
  .map((l: string) => l.replace(/^-\s*/, '').trim())
  .filter(Boolean);
ok(
  '清单与 tools 数组完全一致',
  JSON.stringify(listed.sort()) === JSON.stringify([...toolNames].sort()),
  `\n    清单=${JSON.stringify(listed.sort())}\n    tools=${JSON.stringify([...toolNames].sort())}`
);

console.log('\n[7] B1 工具注册表唯一化');
ok('注册表含 13 个工具（原 11 + play_music / control_music）', ALL_TOOL_NAMES.length === 13, String(ALL_TOOL_NAMES));
const defs = activeToolDefs('t1');
ok('下发的每个工具都来自注册表', defs.every((t: { name: string }) => ALL_TOOL_NAMES.includes(t.name)));
ok('每个工具都有 description', defs.every((t: { description: string }) => !!t.description));
ok(
  'required 字段都在 properties 里（schema 自洽）',
  defs.every((t: any) => (t.parameters.required || []).every((r: string) => r in t.parameters.properties))
);

const ctx = { owner: 't1', sessionId: 's1', intent: 'other' as any };
ok('save_memory 可执行', (await execTool('save_memory', { kind: 'preference', key: '测试', value: '喜欢咖啡' }, ctx)).includes('已记住'));
ok('recall_memory 能读回来', (await execTool('recall_memory', { query: '咖啡' }, ctx)).includes('咖啡'));
await execTool('set_reminder', { what: '回归测试待办', when: '明天 9 点' }, ctx);
const rt = db.listReminders('t1').find((r) => r.body === '回归测试待办');
ok('set_reminder 落库且已结构化 due_ts', !!rt && rt.due_ts !== null, JSON.stringify(rt?.due_ts));
ok('get_schedule 列出待办', (await execTool('get_schedule', {}, ctx)).includes('1.'));
ok('未知工具返回文本而非抛错', (await execTool('no_such_tool', {}, ctx)).startsWith('未知工具'));
ok('工具异常被兜住，不打断会话', (await execTool('checkin_mood', { level: '不是数字' }, ctx)).startsWith('工具执行出错'));

try {
  fs.unlinkSync(tmp);
} catch {
  /* ignore */
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
