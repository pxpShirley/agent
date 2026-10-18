/**
 * 回归探针：主动卡内联动作（A4 能力扩张）
 *
 * 验证：actions 字段存读往返、executeProactiveAction 服务端分支真实改写 DB
 * （完成打卡 → reminder.done=1 / 顺延 → due_ts 推移且一次性刷新 due_at、周期保留文案）、
 * owner 越权拒绝、无 ref_id 的卡片拒绝服务端动作、客户端动作返回 clientOnly。
 *
 * 运行：npx tsx scripts/proactive-action-probe.ts   （package.json test 链已串入）
 */
import os from 'os';
import path from 'path';

const tmp = path.join(os.tmpdir(), `proactive-${Date.now()}.db`);
process.env.CHAT_DB_PATH = tmp;

const proactive = await import('../server/db/proactive.js');
const reminders = await import('../server/db/reminders.js');
const {
  addProactiveCard,
  getProactiveCardById,
  executeProactiveAction,
  parseActions,
  ProactiveActionType,
} = proactive as typeof proactive;
const { addReminder, getReminderById } = reminders as typeof reminders;

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

const OWNER = 'guest';
const DAY = 86_400_000;

console.log('\n[A] actions 字段存读往返');
const card = addProactiveCard({
  owner: OWNER,
  kind: 'reminder_due',
  title: '提醒到了：买菜',
  body: '原定 09:30',
  ref_id: 'r-xyz',
  actions: [
    { type: 'complete', label: '完成打卡' },
    { type: 'snooze_day', label: '顺延1天' },
    { type: 'ask_agent', label: '一键问栖光', payload: { prompt: '怎么处理' } },
    { type: 'open_view', label: '跳转视图', payload: { view: 'dashboard' } },
  ],
});
const reread = getProactiveCardById(card.id)!;
ok('读回 actions 长度一致', reread.actions.length === 4, `got ${reread.actions.length}`);
ok('读回 type/label/payload', reread.actions[3].type === 'open_view' && reread.actions[3].payload?.view === 'dashboard');
ok('无 actions 字段降级为 []', parseActions(undefined).length === 0 && parseActions('not json').length === 0);
ok('非法 type 被丢弃', parseActions('[{"type":"hack","label":"x"}]').length === 0);

console.log('\n[B] 完成打卡 → 真实改写 reminder.done');
const r1 = addReminder(OWNER, '交水电费', '2026-10-06T09:30:00');
const c1 = addProactiveCard({ owner: OWNER, kind: 'reminder_due', title: 't', ref_id: r1.id, actions: [{ type: 'complete', label: '完成打卡' }] });
const res1 = executeProactiveAction(OWNER, c1.id, 'complete' as ProactiveActionType);
ok('complete 返回 ok', res1.ok === true);
ok('reminder 被标记完成', getReminderById(r1.id)?.done === 1);
ok('卡片被收起（dismissed）', getProactiveCardById(c1.id)?.status === 'dismissed');

console.log('\n[C] 顺延 → due_ts 推移，一次性刷新文案 / 周期保留文案');
const r2 = addReminder(OWNER, '买菜', '2026-10-06T09:30:00');
const before2 = getReminderById(r2.id)!;
const c2 = addProactiveCard({ owner: OWNER, kind: 'reminder_due', title: 't', ref_id: r2.id, actions: [{ type: 'snooze_day', label: '顺延1天' }] });
executeProactiveAction(OWNER, c2.id, 'snooze_day' as ProactiveActionType);
const after2 = getReminderById(r2.id)!;
ok('一次性 due_ts 推进 1 天', after2.due_ts === before2.due_ts! + DAY, `Δ=${after2.due_ts! - before2.due_ts!}`);
ok('一次性 due_at 同步刷新', after2.due_at === `${10}月${7}日 09:30` || /10月7日 09:30/.test(after2.due_at || ''), `got ${after2.due_at}`);

const r3 = addReminder(OWNER, '健身', null, undefined, { freq: 'weekly', days: [1], at: '08:30' });
const before3 = getReminderById(r3.id)!;
const label3 = before3.due_at;
const c3 = addProactiveCard({ owner: OWNER, kind: 'reminder_due', title: 't', ref_id: r3.id, actions: [{ type: 'snooze_hour', label: '顺延1小时' }] });
executeProactiveAction(OWNER, c3.id, 'snooze_hour' as ProactiveActionType);
const after3 = getReminderById(r3.id)!;
ok('周期 due_ts 推进 1 小时', after3.due_ts === before3.due_ts! + 3600_000);
ok('周期 due_at 保留人类可读文案', after3.due_at === label3, `before=${label3} after=${after3.due_at}`);

console.log('\n[D] 越权 / 无 ref_id / 非法 type / 客户端动作');
const c4 = addProactiveCard({ owner: 'alice', kind: 'reminder_due', title: 't', ref_id: r2.id, actions: [{ type: 'complete', label: 'x' }] });
const r4 = executeProactiveAction(OWNER, c4.id, 'complete' as ProactiveActionType);
ok('owner 不匹配被拒', r4.ok === false && r4.error === 'forbidden');
ok('越权不影响 reminder', getReminderById(r2.id)?.done === 0);

const c5 = addProactiveCard({ owner: OWNER, kind: 'morning', title: 't', actions: [{ type: 'complete', label: 'x' }] });
const r5 = executeProactiveAction(OWNER, c5.id, 'complete' as ProactiveActionType);
ok('无 ref_id 的卡片拒绝服务端动作', r5.ok === false && r5.error === 'no-ref');

const c6 = addProactiveCard({ owner: OWNER, kind: 'reminder_due', title: 't', ref_id: r2.id, actions: [{ type: 'complete', label: 'x' }] });
ok('非法 type 被拒', executeProactiveAction(OWNER, c6.id, 'hack' as any).error === 'invalid-type');

const c7 = addProactiveCard({ owner: OWNER, kind: 'morning', title: 't', actions: [{ type: 'ask_agent', label: '问', payload: { prompt: 'p' } }] });
const r7 = executeProactiveAction(OWNER, c7.id, 'ask_agent' as ProactiveActionType);
ok('客户端动作返回 clientOnly', r7.ok === true && r7.clientOnly === true);
ok('客户端动作后卡片标 seen（不重复浮起）', getProactiveCardById(c7.id)?.status === 'seen');

const unknown = executeProactiveAction(OWNER, 'no-such-id', 'complete' as ProactiveActionType);
ok('卡片不存在返回 card-not-found', unknown.ok === false && unknown.error === 'card-not-found');

console.log(`\n[A4 主动卡内联动作探针] 通过 ${pass} / 失败 ${fail}`);
if (fail > 0) process.exit(1);
