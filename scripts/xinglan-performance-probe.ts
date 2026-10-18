/**
 * 回归探针：栖光 · 形象演出（方向 C）
 *
 * 验证两件事：
 *   1. moodFromText —— 从助手回话读语气：happy / concerned / null，且**绝不产出 waiting**
 *   2. decideMood  —— 情绪时间线的优先级裁决，8 种情绪全部可达
 *
 * 为什么值得固化为测试：形象演出是"感觉"层面的东西，最容易改坏而不自知。
 * 「没能完成」被演成开心、疑问句把暖金稀释成 waiting —— 都属于看一眼代码发现不了的回归。
 *
 * 运行：npx tsx scripts/xinglan-performance-probe.ts   （package.json test 链已串入）
 */
const mood = await import('../src/utils/xinglanMood.js');
const { moodFromText, decideMood, MOOD_LABEL } = mood as typeof mood;

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

const ALL_MOODS = ['calm', 'listening', 'thinking', 'speaking', 'waiting', 'happy', 'concerned', 'sleeping'] as const;

console.log('\n[1] moodFromText —— 正面语气 → happy');
ok('已经帮你设置好', moodFromText('已经帮你设置好明早 8 点的提醒了') === 'happy');
ok('完成了', moodFromText('完成了，本周三个重点已经整理出来') === 'happy');
ok('搞定了', moodFromText('搞定了，行程卡已经生成') === 'happy');
ok('成功', moodFromText('提醒创建成功') === 'happy');
ok('交给我', moodFromText('没问题，交给我') === 'happy');
ok('记下了', moodFromText('记下了，明天这个时候我会提醒你') === 'happy');

console.log('\n[2] moodFromText —— 负面语气 → concerned（且必须压过正面词）');
ok('「没能完成」判 concerned 而非 happy（最关键的一条）', moodFromText('抱歉，这件事我没能完成') === 'concerned');
ok('裸「没能完成」', moodFromText('没能完成') === 'concerned');
ok('还没完成', moodFromText('这个还没完成，我再试一次') === 'concerned');
ok('操作失败', moodFromText('操作失败了，接口返回异常') === 'concerned');
ok('没找到记录', moodFromText('没找到相关的记录') === 'concerned');
ok('未完成 + 已完成 同句仍判负面', moodFromText('前两项已完成，最后一项没能完成') === 'concerned');
ok('风险/注意', moodFromText('这里有个风险需要你注意') === 'concerned');
ok('超时中断', moodFromText('请求超时中断了') === 'concerned');
ok('逾期', moodFromText('这条已经逾期两天了') === 'concerned');
ok('无法确定', moodFromText('我暂时无法确定具体时间') === 'concerned');

console.log('\n[3] moodFromText —— 读不出就不演 → null');
ok('空串 → null', moodFromText('') === null);
ok('纯空白 → null', moodFromText('   \n\t ') === null);
ok('中性陈述 → null', moodFromText('我先梳理一下这三个方向') === null);
ok('单纯反问 → null（不能演成情绪）', moodFromText('你想先从哪一块聊起？') === null);
ok('「需要你确认」→ null（暖金由 pendingQ 决定，不由文本猜）', moodFromText('需要你确认一下再继续') === null);

console.log('\n[4] moodFromText —— 硬约束：绝不产出 waiting');
{
  const corpus = [
    '', '  ', '好的', '完成了', '没能完成', '抱歉', '失败', '风险',
    '需要你确认吗？', '你要我继续吗', '等你决定', '请问现在方便吗？',
    '已经帮你设置好提醒', '没找到相关记录', '这条已经逾期',
    '是否需要我帮你取消？', '确认后我立刻执行', 'waiting', '等你',
  ];
  const bad = corpus.filter((t) => moodFromText(t) === 'waiting');
  ok(`语料 ${corpus.length} 条中无一产出 waiting`, bad.length === 0, bad.length ? `泄漏: ${JSON.stringify(bad)}` : '');

  const illegal = corpus
    .map((t) => moodFromText(t))
    .filter((m): m is string => m !== null && m !== 'happy' && m !== 'concerned');
  ok('返回值只可能是 happy / concerned / null', illegal.length === 0, illegal.length ? `越界: ${illegal.join(',')}` : '');
}

console.log('\n[5] decideMood —— 优先级裁决');
const base = { waiting: false, recording: false, thinking: false, streaming: false, frozen: null, asleep: false };
const d = (over: Partial<typeof base>) => decideMood({ ...base, ...over });
ok('全静 → calm', d({}) === 'calm');
ok('waiting 压过一切（包括刚送达的 happy）', d({ waiting: true, frozen: 'happy', streaming: true, thinking: true }) === 'waiting');
ok('recording 压过 thinking/streaming', d({ recording: true, thinking: true, streaming: true }) === 'listening');
ok('thinking 压过 streaming', d({ thinking: true, streaming: true }) === 'thinking');
ok('streaming 压过冻结情绪', d({ streaming: true, frozen: 'concerned' }) === 'speaking');
ok('冻结情绪压过 asleep', d({ frozen: 'happy', asleep: true }) === 'happy');
ok('asleep → sleeping', d({ asleep: true }) === 'sleeping');
ok('thinking 且 asleep 仍判 thinking（有人喊它就得醒）', d({ thinking: true, asleep: true }) === 'thinking');

console.log('\n[6] 8 种情绪全部可达（防止又出现死状态）');
{
  const reached = new Set<string>([
    d({}),
    d({ recording: true }),
    d({ thinking: true }),
    d({ streaming: true }),
    d({ waiting: true }),
    d({ frozen: 'happy' }),
    d({ frozen: 'concerned' }),
    d({ asleep: true }),
  ]);
  for (const m of ALL_MOODS) ok(`可达 ${m}`, reached.has(m));
  ok('恰好 8 种，不多不少', reached.size === 8, `实际 ${reached.size}`);
}

console.log('\n[7] MOOD_LABEL —— 每种情绪都有文案');
{
  const missing = ALL_MOODS.filter((m) => !MOOD_LABEL[m]);
  ok('8 种情绪文案齐备', missing.length === 0, missing.join(','));
  ok('安睡文案为「安睡」', MOOD_LABEL.sleeping === '安睡');
  ok('待你确认文案为「等你」', MOOD_LABEL.waiting === '等你');
  ok('文案里出现「等你」的只有 waiting 一条', ALL_MOODS.filter((m) => MOOD_LABEL[m].includes('等你')).length === 1);
}

console.log(`\n${fail === 0 ? '✅' : '❌'} 形象演出探针：${pass} 通过 / ${fail} 失败\n`);
if (fail > 0) process.exit(1);
