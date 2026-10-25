/**
 * 回归探针：F1 自动写 experience / F2 生活教练层 / F3 习惯发现
 *
 * 运行：npx tsx scripts/proactive-probe.ts
 * 用独立 CHAT_DB_PATH 隔离，不污染真实库。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmp = path.join(os.tmpdir(), `proactive-${Date.now()}.db`);
process.env.CHAT_DB_PATH = tmp;

const db = await import('../server/db.js');
const { runMockAgentTurn } = await import('../server/agent.js');
const {
  detectRoutines,
  syncRoutines,
  routineMatchesNow,
  runRoutineCheckins,
  buildMorning,
  buildWeekly,
} = await import('../server/scheduler.js');

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

async function drain(gen: AsyncGenerator<any>): Promise<void> {
  for await (const _ of gen) {
    /* 跑完整个 agent 轮，触发所有副作用（记忆/待办写入） */
  }
}

console.log('\n[F1] 自动写 experience（episodic 记忆）');
await drain(
  runMockAgentTurn({ sessionId: 's-f1', message: '今天项目终于上线了，折腾了我们两个礼拜', customerName: 'f1-probe', intent: 'other' })
);
{
  const exps = db.getMemories('f1-probe', 200).filter((m: any) => m.kind === 'experience');
  ok('叙事类消息被存为 experience 记忆', exps.length >= 1, JSON.stringify(exps.map((m: any) => m.key)));
  ok('experience 键以「经历·」前缀去重', exps.some((m: any) => m.key.startsWith('经历·')));
}
// 情绪倾诉也该落 experience（F1 在 mood 分支顺手记）
await drain(
  runMockAgentTurn({ sessionId: 's-f1b', message: '昨天跟老板吵架了，我真的好难过', customerName: 'f1-probe', intent: 'other' })
);
{
  const exps = db.getMemories('f1-probe', 200).filter((m: any) => m.kind === 'experience');
  ok('情绪倾诉也被记成 experience', exps.length >= 2, `→ ${exps.length}`);
}

console.log('\n[F2] 生活教练层（现状→理想状态）');
await drain(
  runMockAgentTurn({ sessionId: 's-f2', message: '我希望能瘦下来，今年要把身体搞好', customerName: 'f2-probe', intent: 'other' })
);
{
  const goals = db.getMemories('f2-probe', 200).filter((m: any) => m.kind === 'plan' && m.key.startsWith('理想状态'));
  ok('愿望被存为 plan 记忆（key 以「理想状态」开头）', goals.length >= 1, JSON.stringify(goals.map((m: any) => m.key)));
  const morning = buildMorning('f2-probe');
  ok('晨报带出理想状态教练句', morning.body.includes('想「'), morning.body.slice(0, 200));
  const weekly = buildWeekly('f2-probe');
  ok('周复盘也回望理想状态', weekly.body.includes('理想状态') || weekly.body.includes('想「'), weekly.body.slice(0, 200));
}

console.log('\n[F3] 习惯发现（从周期提醒推导，真实信号驱动主动）');
db.addReminder('f3-probe', '喝水', null, [], { freq: 'daily', at: '22:00' });
{
  const rs = detectRoutines('f3-probe');
  ok('从周期提醒推导出 1 个习惯', rs.length === 1, `→ ${rs.length}`);
  ok('推导出的习惯含 what/freq/at', rs[0]?.what === '喝水' && rs[0]?.freq === 'daily' && rs[0]?.at === '22:00');
  const added = syncRoutines('f3-probe');
  ok('syncRoutines 写入 1 条 routine 记忆', added === 1, `→ ${added}`);
  ok('routine 记忆已落库', db.getMemories('f3-probe', 200).some((m: any) => m.kind === 'routine'));
  // 幂等：再跑一次不重复写
  const added2 = syncRoutines('f3-probe');
  ok('syncRoutines 幂等（二次新增为 0）', added2 === 0, `→ ${added2}`);
}

console.log('\n[F3] routineMatchesNow 时间/星期匹配');
ok('daily@22:00 在 22 点命中', routineMatchesNow({ freq: 'daily', at: '22:00' }, new Date(2026, 0, 1, 22, 0)));
ok('daily@22:00 在 10 点不命中（超出 ±1h 窗口）', !routineMatchesNow({ freq: 'daily', at: '22:00' }, new Date(2026, 0, 1, 10, 0)));
ok('weekly[一]@22:00 在周一命中', routineMatchesNow({ freq: 'weekly', at: '22:00', days: [1] }, new Date(2026, 0, 5, 22, 0))); // 2026-01-05 周一
ok('weekly[一]@22:00 在周二不命中', !routineMatchesNow({ freq: 'weekly', at: '22:00', days: [1] }, new Date(2026, 0, 6, 22, 0))); // 2026-01-06 周二

console.log('\n[F3] runRoutineCheckins 软提醒 + 7 天节流');
{
  const pushed1 = runRoutineCheckins('f3-probe', new Date(2026, 0, 1, 22, 0));
  ok('匹配时刻生成 1 张 routine 卡片', pushed1 === 1, `→ ${pushed1}`);
  const card = db.getProactive('f3-probe').find((c: any) => c.kind === 'routine');
  ok('卡片内容带习惯名与提问', !!card && card.body.includes('喝水'), JSON.stringify(card?.body || '').slice(0, 60));
  const pushed2 = runRoutineCheckins('f3-probe', new Date(2026, 0, 1, 22, 0));
  ok('7 天内同习惯不再重复推（节流生效）', pushed2 === 0, `→ ${pushed2}`);
}

console.log('\n[F3] 免打扰时段跳过 routine 软提醒');
{
  db.saveMemory('f3-quiet', 'preference', '作息', '晚上 11 点后少打扰');
  db.addReminder('f3-quiet', '冥想', null, [], { freq: 'daily', at: '23:30' });
  syncRoutines('f3-quiet');
  // 23:30 落在「11 点后」免打扰窗口 → 不推
  const pushed = runRoutineCheckins('f3-quiet', new Date(2026, 0, 1, 23, 30));
  ok('免打扰时段内 routine 软提醒被跳过', pushed === 0, `→ ${pushed}`);
}

try {
  fs.rmSync(tmp, { force: true });
  fs.rmSync(`${tmp}-wal`, { force: true });
  fs.rmSync(`${tmp}-shm`, { force: true });
} catch {
  /* 清理失败不影响结论 */
}

console.log(`\n通过 ${pass} / 失败 ${fail}\n`);
if (fail) process.exit(1);
