/**
 * 回归探针：周期 / 习惯提醒（B2 能力扩张）
 *
 * 验证：规则解析/文案/下一期计算、addReminder 写周期、去重、打卡后自动滚下一期、
 * count 限制、一次性不滚动、子步骤清零。
 *
 * 运行：npx tsx scripts/recur-probe.ts   （package.json test 链已串入）
 */
import os from 'os';
import path from 'path';

const tmp = path.join(os.tmpdir(), `recur-${Date.now()}.db`);
process.env.CHAT_DB_PATH = tmp;

const recur = await import('../server/recur.js');
const rem = await import('../server/db/reminders.js');
const { parseRecur, humanizeRecur, nextOccurrence, firstOccurrence } = recur as typeof recur;
const { addReminder, completeReminder, getReminderById, listReminders } = rem as typeof rem;

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

// 固定时间锚点，避免「现在」导致的时区/漂移误差
const ts = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0).getTime();

console.log('\n[1] parseRecur —— 容错解析');
ok('daily 合法', parseRecur({ freq: 'daily', at: '22:00' })?.freq === 'daily');
ok('weekly days 收成 0-6 且去重排序', JSON.stringify(parseRecur({ freq: 'weekly', days: [5, 1, 1, 3] })?.days) === JSON.stringify([1, 3, 5]));
ok('monthly dom 越界被夹到 1-31', parseRecur({ freq: 'monthly', dom: 99 })?.dom === 31 && parseRecur({ freq: 'monthly', dom: 0 })?.dom === 1);
ok('非法 freq → null', parseRecur({ freq: 'yearly' }) === null);
ok('脏 JSON → null', parseRecur('not json') === null);
ok('null → null', parseRecur(null) === null);

console.log('\n[2] humanizeRecur —— 人类可读');
ok('daily', humanizeRecur({ freq: 'daily', at: '22:00' }) === '每天 22:00');
ok('weekly', humanizeRecur({ freq: 'weekly', days: [1, 3, 5], at: '08:30' }) === '每周一、三、五 08:30');
ok('monthly', humanizeRecur({ freq: 'monthly', dom: 1, at: '09:00' }) === '每月 1 日 09:00');
ok('缺 at 兜底 09:00', humanizeRecur({ freq: 'daily' }) === '每天 09:00');

console.log('\n[3] nextOccurrence —— 下一期计算（固定锚点）');
{
  const daily = nextOccurrence({ freq: 'daily', at: '22:00' }, ts(2026, 10, 6, 23, 0));
  const d = new Date(daily);
  ok('daily 当天已过则顺延到次日 22:00', d.getFullYear() === 2026 && d.getMonth() === 9 && d.getDate() === 7 && d.getHours() === 22 && d.getMinutes() === 0);

  // 2026-10-06 是周二(getDay=2)，weekly 一三五(1,3,5) → 下一期周三 10-07 08:00
  const weekly = nextOccurrence({ freq: 'weekly', days: [1, 3, 5], at: '08:00' }, ts(2026, 10, 6, 10, 0));
  const w = new Date(weekly);
  ok('weekly 取到下一匹配星期', w.getMonth() === 9 && w.getDate() === 7 && w.getDay() === 3 && w.getHours() === 8);

  const monthly = nextOccurrence({ freq: 'monthly', dom: 15, at: '09:00' }, ts(2026, 10, 6, 10, 0));
  const m = new Date(monthly);
  ok('monthly 取当月 15 号', m.getMonth() === 9 && m.getDate() === 15);

  const monthClamp = nextOccurrence({ freq: 'monthly', dom: 31, at: '09:00' }, ts(2026, 2, 6, 10, 0));
  const mc = new Date(monthClamp);
  ok('monthly 31 号在小月夹到月末(2月→28)', mc.getMonth() === 1 && mc.getDate() === 28);

  // 完成本期后严格晚于本期：10-06 22:00 完成 → 下一期 10-07 22:00（不是今天）
  const roll = nextOccurrence({ freq: 'daily', at: '22:00' }, ts(2026, 10, 6, 22, 0));
  const rl = new Date(roll);
  ok('滚动生成严格晚于本期', rl.getMonth() === 9 && rl.getDate() === 7 && rl.getHours() === 22);
}

console.log('\n[4] addReminder 写周期');
{
  const r1 = addReminder('guest', '喝水', null, undefined, { freq: 'daily', at: '22:00' });
  ok('recur_rule 已落地', r1.recur_rule?.freq === 'daily' && r1.recur_rule.at === '22:00');
  ok('首期 due_ts 在未来(now 之后)', typeof r1.due_ts === 'number' && r1.due_ts! >= Date.now() - 10);
  ok('series_id 已生成', !!r1.series_id);
  ok('due_at 为人类可读文案', r1.due_at === '每天 22:00');

  const first = firstOccurrence({ freq: 'daily', at: '22:00' }, ts(2026, 10, 6, 10, 0));
  ok('firstOccurrence 取今天 22:00（未过）', new Date(first).getDate() === 6 && new Date(first).getHours() === 22);
  const firstLate = firstOccurrence({ freq: 'daily', at: '08:00' }, ts(2026, 10, 6, 22, 0));
  ok('firstOccurrence 已过则顺延明天', new Date(firstLate).getDate() === 7 && new Date(firstLate).getHours() === 8);
}

console.log('\n[5] 同 body + 同规则 去重');
{
  const before = listReminders('guest', false).filter((r) => r.body === '喝水').length;
  const r2 = addReminder('guest', '喝水', null, undefined, { freq: 'daily', at: '22:00' });
  const after = listReminders('guest', false).filter((r) => r.body === '喝水').length;
  ok('命中去重标记', r2.deduped === true);
  ok('无重复行', after === before);
}

console.log('\n[6] 打卡一期 → 自动滚下一期');
{
  const cur = listReminders('guest', false).find((r) => r.body === '喝水')!;
  const sid = cur.series_id!;
  const oldDue = cur.due_ts!;
  const okComp = completeReminder(cur.id);
  ok('completeReminder 返回 true', okComp === true);
  ok('本期已置 done=1', getReminderById(cur.id)?.done === 1);
  const nexts = listReminders('guest', false).filter((r) => r.body === '喝水');
  ok('生成了下一期（open 仍只有 1 条）', nexts.length === 1);
  const nx = nexts[0];
  ok('下一期 done=0', nx.done === 0);
  ok('下一期 due_ts 严格晚于本期', typeof nx.due_ts === 'number' && nx.due_ts! > oldDue);
  ok('下一期 同 series_id', nx.series_id === sid);
  ok('下一期 仍是周期规则', nx.recur_rule?.freq === 'daily');
  ok('无限次系列 remaining 保持未定义', nx.recur_rule?.remaining === undefined);
}

console.log('\n[7] count 限定：3 次后自动停止');
{
  const created = addReminder('guest', '吃药', null, undefined, { freq: 'daily', at: '09:00', count: 3 });
  ok('count→remaining 在存储层归一化为 count-1', created.recur_rule?.remaining === 2);
  let guard = 0;
  let open = listReminders('guest', false).filter((r) => r.body === '吃药');
  while (open.length && guard < 10) {
    completeReminder(open[0].id);
    open = listReminders('guest', false).filter((r) => r.body === '吃药');
    guard++;
  }
  ok('完成 3 次后不再生成新期（open 归零）', open.length === 0);
  ok('循环次数受 guard 保护且恰好 3 次', guard === 3);
  const done = listReminders('guest', true).filter((r) => r.body === '吃药');
  ok('共产生 3 条记录', done.length === 3);
}

console.log('\n[8] 子步骤随新一期清零');
{
  addReminder('guest', '运动', null, [{ text: '热身' }, { text: '拉伸' }], { freq: 'daily', at: '07:00' });
  const cur = listReminders('guest', false).find((r) => r.body === '运动')!;
  ok('首期带 2 个子步骤', cur.steps.length === 2);
  completeReminder(cur.id);
  const nx = listReminders('guest', false).find((r) => r.body === '运动')!;
  ok('新一期子步骤被清零', nx.steps.length === 2 && nx.steps.every((s) => s.done === 0));
}

console.log('\n[9] 一次性提醒完成不滚动');
{
  const r = addReminder('guest', '交水电费', new Date(Date.now() + 2 * 3600000).toISOString());
  ok('一次性无 recur_rule', r.recur_rule === null);
  completeReminder(r.id);
  const open = listReminders('guest', false).filter((x) => x.body === '交水电费');
  ok('完成后无新期生成', open.length === 0);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
