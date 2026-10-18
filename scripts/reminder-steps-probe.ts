/**
 * 回归探针：待办子步骤（A3 能力扩张）
 *
 * 背景（2026-10-06 起做的能力扩张第一项）：给 reminders 加 steps（JSON 子步骤），
 * 前端可勾选、全部完成自动置待办 done=1、进度按步数算。
 *
 * 运行：npx tsx scripts/reminder-steps-probe.ts
 */
import os from 'os';
import path from 'path';

const tmp = path.join(os.tmpdir(), `reminder-steps-${Date.now()}.db`);
process.env.CHAT_DB_PATH = tmp;

const rem = await import('../server/db/reminders.js');
const { parseSteps, addReminder, setReminderSteps, toggleReminderStep, stepsProgress, getReminderById, listReminders } = rem as typeof rem;

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

console.log('\n[1] parseSteps —— 容错解析');
ok('非法输入降级为 []', parseSteps('not json').length === 0 && parseSteps(null).length === 0 && parseSteps(123).length === 0);
ok('数组解析并重排 seq', JSON.stringify(parseSteps('[{"text":"a"},{"text":"b"}]')) === JSON.stringify([{ seq: 0, text: 'a', done: 0 }, { seq: 1, text: 'b', done: 0 }]));
ok('文本项被过滤', parseSteps('[{"text":""},{"text":"好的"}]').length === 1);
ok('done 布尔/数字归一化为 0/1', parseSteps('[{"text":"x","done":true},{"text":"y","done":0}]')[0].done === 1 && parseSteps('[{"text":"x","done":true}]')[0].done === 1);

console.log('\n[2] addReminder 带 steps');
const r1 = addReminder('guest', '准备出差', null, [{ text: '订机票' }, { text: '订酒店' }]);
ok('steps 已落库并解析', r1.steps.length === 2 && r1.steps[0].text === '订机票');
ok('seq 从 0 连续', r1.steps[0].seq === 0 && r1.steps[1].seq === 1);
ok('listReminders 返回数组而非字符串', Array.isArray(r1.steps) && typeof (r1 as any).steps !== 'string');

console.log('\n[3] toggleReminderStep 勾选与自动完成');
const r1b = toggleReminderStep(r1.id, 0); // 勾第 1 步
ok('勾选后该步 done=1', !!r1b && r1b.steps[0].done === 1);
ok('只勾一步不自动完成', !!r1b && getReminderById(r1.id)!.done !== 1);
const r1c = toggleReminderStep(r1.id, 1); // 勾第 2 步
ok('两步都勾 → 待办自动 done=1', !!r1c && getReminderById(r1.id)!.done === 1);
ok('进度 100%', !!r1c && stepsProgress(r1c.steps).pct === 100);

console.log('\n[4] stepsProgress 进度计算');
ok('空步骤 pct=0 且 total=0', JSON.stringify(stepsProgress([])) === JSON.stringify({ total: 0, done: 0, pct: 0 }));
ok('1/2 → pct 50', JSON.stringify(stepsProgress([{ seq: 0, text: 'a', done: 1 }, { seq: 1, text: 'b', done: 0 }])) === JSON.stringify({ total: 2, done: 1, pct: 50 }));

console.log('\n[5] setReminderSteps 重排与替换');
const r2 = addReminder('guest', '写周报');
const r2b = setReminderSteps(r2.id, [{ text: '汇总' }, { text: '草稿' }, { text: '校对' }]);
ok('写入 3 步且 seq 重排', !!r2b && r2b.steps.length === 3 && r2b.steps[2].seq === 2);
ok('替换为更少步数生效', setReminderSteps(r2.id, [{ text: '只做一件' }])!.steps.length === 1);
ok('空数组清空步骤', setReminderSteps(r2.id, [])!.steps.length === 0);

console.log('\n[6] 幂等去重不丢步骤');
const r4 = addReminder('guest', '买菜清单', null, [{ text: '西红柿' }, { text: '鸡蛋' }]);
const dup = addReminder('guest', '买菜清单', null, [{ text: '新的一步' }]);
ok('同 body（未完成）命中去重', dup.deduped === true);
ok('去重复用原 steps（不覆盖为新步骤）', JSON.stringify(dup.steps) === JSON.stringify(r4.steps));

console.log('\n[7] 全部完成判定只在「有步骤且全完成」时触发');
const r3 = addReminder('guest', '空步骤待办');
ok('无步骤时不会因 steps 被误判完成', getReminderById(r3.id)!.done !== 1);

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
if (fail > 0) process.exit(1);
