/**
 * 回归探针：记忆预注入的「相关性排序 + 字符预算贪心截断」
 *
 * 背景（2026-10-08）：
 *   原来 buildMemoryContext 是「取最近 12 条 + 每条截断 160 字符」——
 *   条数是常数，与本轮问什么无关。后果：模型常拿不到相关的那几条，
 *   只能再花一轮去调 recall_memory，用户多等一整轮。
 *   现在改为 注入量 = min(相关性截断后的条数, 字符预算允许的条数)，
 *   且 agent.ts 的预注入与 registry 的 recall_memory 共用 server/memory.ts（防两处漂移）。
 *
 * 运行：npx tsx scripts/memory-select-probe.ts
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmp = path.join(os.tmpdir(), `mem-select-${Date.now()}.db`);
process.env.CHAT_DB_PATH = tmp;

const { tokenize, relevanceOf, scoreMemory, selectMemories, formatMemoryLine, DEFAULT_MEMORY_BUDGET, KIND_WEIGHT, exportMemoryMarkdown } =
  await import('../server/memory.js');
const db = await import('../server/db.js');
const { buildMemoryContext } = await import('../server/agent.js');

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

const NOW = Date.now();
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const mem = (kind: string, key: string, value: string, msAgo = 0) =>
  ({ id: `${key}-${Math.random()}`, owner: 'probe', kind, key, value, updated_at: iso(msAgo), expire_at: null }) as any;

console.log('\n[1] 分词：中文 2-gram + 停用词过滤');
const tk = tokenize('帮我看看这个提醒');
ok('能切出「提醒」', tk.includes('提醒'));
ok('过滤停用词「帮我」', !tk.includes('帮我'));
ok('过滤停用词「这个」', !tk.includes('这个'));
ok('英文按词切分', tokenize('提醒我 drink water').includes('drink'));
ok('单字中文保留（「糖」）', tokenize('糖').includes('糖'));

console.log('\n[2] 相关性打分');
const sleep = mem('preference', '作息', '通常 23:30 睡觉，早上 7 点起');
const city = mem('fact', '城市', '住在杭州');
const qSleep = tokenize('我一般几点睡觉');
ok('作息记忆命中「睡觉」查询', relevanceOf(sleep, qSleep) > 0, `→ ${relevanceOf(sleep, qSleep)}`);
ok('城市记忆不命中「睡觉」查询', relevanceOf(city, qSleep) === 0);
ok('key 命中额外加分', relevanceOf(mem('fact', '睡觉', 'x'), qSleep) > relevanceOf(sleep, qSleep) - 0.01);
ok('空 query 相关性为 0（退化为新鲜度+类型）', relevanceOf(sleep, []) === 0);

console.log('\n[3] 新鲜度衰减：30 天半衰');
const fresh = mem('note', 'a', 'x', 0);
const old = mem('note', 'a', 'x', 30 * 86_400_000);
ok('今天的比 30 天前的得分高', scoreMemory(fresh, []) > scoreMemory(old, []), `${scoreMemory(fresh, [])} vs ${scoreMemory(old, [])}`);

console.log('\n[4] 类型权重：preference > note');
ok(
  '同新鲜度下 preference 高于 note',
  scoreMemory(mem('preference', 'a', 'x'), []) > scoreMemory(mem('note', 'a', 'x'), [])
);

console.log('\n[5] 相关性优先于新鲜度（老的相关 > 新的无关）');
const oldRelevant = mem('preference', '作息', '通常 23:30 睡觉', 90 * 86_400_000);
const freshIrrelevant = mem('note', '快递', '放在门口', 0);
const picked = selectMemories([freshIrrelevant, oldRelevant], '我一般几点睡觉');
ok('相关但陈旧的排在前面', picked[0]?.key === '作息', `→ ${picked.map((p) => p.key).join(',')}`);

console.log('\n[6] 字符预算是硬约束（条数是结果，不是前提）');
const many = Array.from({ length: 30 }, (_, i) => mem('note', `k${i}`, 'x'.repeat(150), i * 1000));
const sel = selectMemories(many, '');
const usedChars = sel.reduce((s, r) => s + formatMemoryLine(r).length, 0);
ok('条数不超过 maxItems', sel.length <= DEFAULT_MEMORY_BUDGET.maxItems, `→ ${sel.length}`);
ok('总字符不超过 charBudget', usedChars <= DEFAULT_MEMORY_BUDGET.charBudget, `→ ${usedChars}/${DEFAULT_MEMORY_BUDGET.charBudget}`);
ok('确实装填了多条（预算没被浪费）', sel.length >= 8, `→ ${sel.length}`);
ok('预算生效：30 条候选没有全塞进来', sel.length < 30);

console.log('\n[7] 短记忆能装更多（预算按长度算，不按条数算）');
const shorts = Array.from({ length: 30 }, (_, i) => mem('note', `s${i}`, '很短', i * 1000));
const selShort = selectMemories(shorts, '');
ok('短记忆受 maxItems 而非预算限制', selShort.length === DEFAULT_MEMORY_BUDGET.maxItems, `→ ${selShort.length}`);
ok('短记忆塞得下不少于长记忆', selShort.length >= sel.length);

console.log('\n[8] 单条超长截断');
const long = mem('note', '长文', 'y'.repeat(500));
ok('截断到 snippetMax + 省略号', formatMemoryLine(long).length < 200 && formatMemoryLine(long).endsWith('…'));

console.log('\n[9] buildMemoryContext 端到端（带 query 的预注入）');
db.saveMemory('probe-user', 'preference', '作息', '通常 23:30 睡觉，早上 7 点起');
db.saveMemory('probe-user', 'fact', '城市', '住在杭州');
for (let i = 0; i < 15; i++) db.saveMemory('probe-user', 'note', `噪音${i}`, `无关内容 ${i}`.repeat(8));
const ctx = buildMemoryContext('probe-user', '帮我提醒我今晚早点睡觉');
ok('上下文里出现了作息那条', ctx.includes('作息'), ctx.slice(0, 120));
ok('上下文受预算约束（不是 17 条全塞）', ctx.split('\n').length <= DEFAULT_MEMORY_BUDGET.maxItems, `→ ${ctx.split('\n').length} 行`);
ok('空用户返回占位文案', buildMemoryContext('nobody-here', 'x').includes('暂无记录'));

console.log('\n[10] 主循环 span 统计（L0+ ②）');
const stats = db.getLoopStats(50);
ok('getLoopStats 可调用', typeof stats.runs === 'number');
db.addAgentRun({
  session_id: 's1',
  prompt: 'p',
  intent: 'other',
  tools_used: 'recall_memory,get_schedule',
  outcome: 'handled',
  model: 'deepseek-chat',
  iterations: 2,
  tool_calls_count: 2,
  parallel_rounds: 1,
  latency_ms: 3000,
});
const s2 = db.getLoopStats(50);
ok('span 写入后可统计', s2.runs >= 1 && s2.avgIterations === 2, JSON.stringify(s2));
ok('并发轮次被记到', s2.parallelRuns >= 1);
ok('工具频次可统计', s2.topTools.some((t) => t.name === 'recall_memory'));

console.log('\n[11] P1 新记忆 kind 词表（借 Hindsight 4 桶：事实/经历/观察/心智模型）');
ok('KIND_WEIGHT 含 experience（经历）', KIND_WEIGHT.experience === 0.7, `→ ${KIND_WEIGHT.experience}`);
ok('KIND_WEIGHT 含 observation（观察）', KIND_WEIGHT.observation === 0.85, `→ ${KIND_WEIGHT.observation}`);
ok('KIND_WEIGHT 含 mental（心智模型）', KIND_WEIGHT.mental === 0.95, `→ ${KIND_WEIGHT.mental}`);
ok('旧 kind 权重向后兼容（preference 仍 1.0）', KIND_WEIGHT.preference === 1.0);
ok('旧 kind 权重向后兼容（note 仍 0.4）', KIND_WEIGHT.note === 0.4);
// db.saveMemory 不校验 kind（存任意字符串），新词表即可直接写入
db.saveMemory('probe-user', 'experience', '换工作', '上次聊过要不要换工作，用户说纠结');
ok('新 kind 可被 saveMemory 写入', db.getMemories('probe-user', 50).some((m) => m.kind === 'experience'));

console.log('\n[12] P1 episodic 弱召回（模糊 query 时近期 experience 上浮，不破坏相关性优先）');
const expOld = mem('experience', '换工作', '上次聊过要不要换工作，用户说纠结', 10 * 86_400_000);
const expNew = mem('experience', '换工作', '上次聊过要不要换工作，用户说纠结', 1 * 86_400_000);
const noteNew = mem('note', '杂事', '门口快递', 1 * 86_400_000);
const vaguePick = selectMemories([expOld, expNew, noteNew], '在吗');
ok('模糊 query 下近期 experience 被召回', vaguePick.some((r) => r.kind === 'experience' && r.key === '换工作'), vaguePick.map((r) => `${r.kind}:${r.key}`).join(','));
ok('模糊 query 下近期 experience 排在陈旧之前', vaguePick[0]?.kind === 'experience' && vaguePick[0]?.key === '换工作', vaguePick.map((r) => `${r.kind}:${r.key}`).join(','));

const relFact = mem('fact', '换工作', '用户想换工作，行业是互联网', 0); // 相关且新鲜
const pickRel = selectMemories([relFact, expOld], '换工作进展如何');
ok('有明确关键词时相关性优先于陈旧 experience', pickRel[0]?.kind === 'fact', pickRel.map((r) => `${r.kind}:${r.key}`).join(','));
ok('episodic 弱召回未破坏预算/条数约束', pickRel.length <= DEFAULT_MEMORY_BUDGET.maxItems);

console.log('\n[13] P1 记忆可检视导出（OpenClaw 教训：纯文件可读）');
const md = exportMemoryMarkdown([
  mem('preference', '作息', '通常 23:30 睡觉'),
  mem('experience', '换工作', '上次聊过纠结'),
  mem('fact', '城市', '住在杭州'),
  mem('mental', '用户画像', '典型夜猫子，决策前需要给选项'),
]);
ok('导出含分组标题「偏好」', md.includes('## 偏好'));
ok('导出含分组标题「经历」', md.includes('## 经历'));
ok('导出含分组标题「心智模型」', md.includes('## 心智模型'));
ok('导出含具体记忆内容', md.includes('23:30 睡觉') && md.includes('上次聊过纠结') && md.includes('夜猫子'));
ok('导出按权重排序（心智模型在偏好前）', md.indexOf('## 心智模型') < md.indexOf('## 偏好'));

try {
  fs.rmSync(tmp, { force: true });
  fs.rmSync(`${tmp}-wal`, { force: true });
  fs.rmSync(`${tmp}-shm`, { force: true });
} catch {
  /* 清理失败不影响结论 */
}

console.log(`\n通过 ${pass} / 失败 ${fail}\n`);
if (fail) process.exit(1);
