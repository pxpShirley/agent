/**
 * 回归探针：「空泛反问」护栏（server/clarify.ts）
 *
 * 背景（2026-10-18）：用户说「帮我设个提醒」这类信息不全的话，模型约 1/5 概率回一句
 * 「提醒什么事？」——提示词第 7 条改三版没治住。护栏在**能力层**把死问题换成
 * 「推断 + 具体时间 + 可点选选项」，确定性、可单测。
 *
 * 本探针锁住护栏的纯函数契约：
 *   A. 判定：isBareQuestion 只在「短 + 无具体默认值 + 整句是空泛反问」时为真；
 *   B. 观察窗：couldBeBareQuestion 必须是 isBareQuestion 的超集（宁可多憋字，不可漏拦）；
 *   C. 生成：buildClarification 的产物**不得**含任何空泛反问话术、且**必须**带具体时间；
 *   D. 总入口：guardBareQuestion 只在提醒一族 + 真·空泛反问时 repaired:true；
 *   E. 单一真相源：evals 的 EMPTY_QUESTION 就是 BARE_QUESTION_PHRASES 本身。
 *
 * 运行：npx tsx scripts/clarify-probe.ts
 */
import {
  BARE_QUESTION_PHRASES,
  isBareQuestion,
  hasConcreteDefault,
  couldBeBareQuestion,
  buildClarification,
  guardBareQuestion,
  isReminderish,
} from '../server/clarify.js';
import { EMPTY_QUESTION } from '../evals/cases.js';

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? `  → ${extra}` : ''}`);
  }
};

const REMINDER_MSG = '帮我设个提醒';
const NOREM_MSG = '北京今天天气怎么样';

// —— A. 判定 isBareQuestion ——
const bareSamples = ['提醒什么事？', '你想提醒什么', '能具体说说吗', '想做什么？', '要做什么呢？', '什么时候？'];
for (const s of bareSamples) ok(`isBareQuestion 真值：${s}`, isBareQuestion(s));

ok('isBareQuestion 空串为假', !isBareQuestion(''));
ok('isBareQuestion 长回复为假（>40 字也含空泛词）', !isBareQuestion('这个我不太确定，你能具体说说是什么事吗？我方便更好地帮你安排。'.repeat(2)));
ok('isBareQuestion 带默认值为假（今晚 22:30）', !isBareQuestion('帮你设个「今晚 22:30 早点睡」的提醒？要换就改。'));
ok('isBareQuestion 普通短答为假（记下了）', !isBareQuestion('好，已经记下了 ✅'));
ok('isBareQuestion 单字疑问为假（嗯？）', !isBareQuestion('嗯？'));

// —— B. 观察窗 couldBeBareQuestion 是 isBareQuestion 超集 ——
for (const s of bareSamples) {
  ok(`couldBe 含 isBare：${s}`, couldBeBareQuestion(s, { message: REMINDER_MSG }), '应是超集');
}
ok('couldBe 含 isBare（长但未到 40 的上限附近）', couldBeBareQuestion('提醒什么内容呢', { message: REMINDER_MSG }));
ok('couldBe 一遇具体时间即放行（今晚 22:30）', !couldBeBareQuestion('提醒什么事？今晚 22:30 记上', { message: REMINDER_MSG }));
ok('couldBe 非提醒一族直接放行（天气）', !couldBeBareQuestion('你想查哪个城市？', { message: NOREM_MSG }));

// —— C. hasConcreteDefault ——
ok('hasConcreteDefault 数字', hasConcreteDefault('明早 9:00 叫你'));
ok('hasConcreteDefault 时间词', hasConcreteDefault('晚上十点提醒我'));
ok('hasConcreteDefault 无默认值', !hasConcreteDefault('提醒什么事？'));

// —— D. buildClarification 契约 ——
const corpus = [
  { ctx: { message: '帮我设个提醒' }, label: '纯缺信息' },
  { ctx: { message: '帮我设个提醒', history: ['明天上午十点我要去国贸三期开会'] }, label: '多轮·有事件' },
  { ctx: { message: '记一下', history: ['明早八点喝水'] }, label: '多轮·有时间' },
];
for (const item of corpus) {
  const c = buildClarification(item.ctx);
  ok(`build 不含空泛反问话术（${item.label}）`, !BARE_QUESTION_PHRASES.some((p) => c.text.includes(p)), c.text.slice(0, 40));
  ok(`build 带具体时间（${item.label}）`, hasConcreteDefault(c.text), c.text.slice(0, 40));
  ok(`build 选项非空且 ≥3（${item.label}）`, c.choices.length >= 3 && c.choices.every((x) => x && x.trim()));
  ok(`build 选项不重复（${item.label}）`, new Set(c.choices).size === c.choices.length);
  // 幂等：护栏生成的回复自己不能再被判成空泛反问
  ok(`build 幂等·自身非 bare（${item.label}）`, !isBareQuestion(c.text));
}

// 多轮·有事件：应把上文的「国贸三期开会」与时间捡回来
const multi = buildClarification({ message: '帮我设个提醒', history: ['明天上午十点我要去国贸三期开会'] });
ok('多轮捡回事件名', multi.text.includes('国贸三期开会'), multi.text.slice(0, 60));
ok('多轮捡回时间', multi.text.includes('明天上午十点'), multi.text.slice(0, 60));
ok('多轮首个选项以「就按」开头（确认项）', multi.choices[0].startsWith('就按'), multi.choices[0]);

// —— E. guardBareQuestion 总入口 ——
ok('guard 非提醒一族·空泛也不修', guardBareQuestion('你想查哪个城市？', { message: NOREM_MSG }).repaired === false);
ok('guard 提醒一族·好回复不修', guardBareQuestion('好，已经记下了 ✅', { message: REMINDER_MSG }).repaired === false);
const fixed = guardBareQuestion('提醒什么事？', { message: REMINDER_MSG });
ok('guard 提醒一族·空泛则修', fixed.repaired === true);
if (fixed.repaired) {
  ok('guard 修复文本带时间', hasConcreteDefault(fixed.text), fixed.text.slice(0, 40));
  ok('guard 修复产出选项', fixed.choices.length >= 3);
}

// —— F. 单一真相源 ——
ok('isReminderish 命中提醒', isReminderish('帮我设个提醒'));
ok('isReminderish 不命中天气', !isReminderish('北京天气'));
ok('EMPTY_QUESTION === BARE_QUESTION_PHRASES（单一真相源）', EMPTY_QUESTION === BARE_QUESTION_PHRASES);
ok('话术库非空且含「提醒什么事」', BARE_QUESTION_PHRASES.includes('提醒什么事'));

console.log(`\nclarify-probe：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
