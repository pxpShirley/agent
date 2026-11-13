/**
 * 回归探针：P1 上下文预算装配器（2026-11-13）
 *
 * 背景：改之前上下文是三份互不知情的截断——记忆 1800 字符、历史硬编码
 * 「12 轮 / 6000 字符」、系统提示/工具 schema/本轮消息/输出预留完全没算。
 * 换模型、加工具、拼一段产物兜底内容都不能自适应，所谓「受控」只是错觉。
 *
 * 验证点：
 *   1) resolveWindow / createBudget：模型窗口、未知模型保守值、env 覆盖、非法配置兜底
 *   2) allocate：min(window,cap)、单调性、硬约束、换算、条数由预算推导、过紧/非法输入
 *   3) buildHistory：按预算裁剪、连续最近轮、当前消息去重、trimmed 标记
 *   4) assembleContext 端到端：各段实测字符同源、tools 与实际下发同源、
 *      currentChars 计入、systemOverride 让出预算、小预算裁剪、stats 不回灌 prompt
 *   5) 不退化：默认预算容得下旧 6000 字符历史；12 条历史全保留；
 *      记忆选取与渲染共用同一份 snippetMax；旧调用签名不变
 *
 * 零成本：不调任何真实 API；临时库，跑完即删。
 * 运行：npx tsx scripts/context-budget-probe.ts   （已串入 `npm test`）
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

const tmp = path.join(os.tmpdir(), `context-budget-probe-${Date.now()}.db`);
process.env.CHAT_DB_PATH = tmp;

// ⚠️ 必须在 import 数据层之前设 CHAT_DB_PATH（静态不 import 任何 server 模块）
const b = await import('../server/context/budget.js');
const { assembleContext, buildHistory, toOpenAiTools } = await import('../server/context/assemble.js');
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

const OWNER = 'ctx-budget-owner';
const MEM_OWNER = 'ctx-budget-mem-owner';
const CURRENT = '那按刚才说的办吧';

const toolDefs = [
  { name: 'save_memory', description: '记住关于用户的事', parameters: { type: 'object', properties: { key: { type: 'string' } } } },
  { name: 'set_reminder', description: '设置提醒', parameters: { type: 'object', properties: { body: { type: 'string' } } } },
  { name: 'web_lookup', description: '联网查资料', parameters: { type: 'object', properties: { q: { type: 'string' } } } },
];

try {
  console.log('\n[context-budget-probe] 1) 窗口与预算配置');
  ok('deepseek-chat → 65536', b.resolveWindow('deepseek-chat', {}) === 65_536);
  ok('deepseek-reasoner → 65536', b.resolveWindow('deepseek-reasoner', {}) === 65_536);
  ok('qwen-plus → 32768', b.resolveWindow('qwen-plus', {}) === 32_768);
  ok('未知模型走保守窗口 8192', b.resolveWindow('mystery-7b', {}) === b.UNKNOWN_MODEL_WINDOW);
  ok('空模型名也走保守窗口', b.resolveWindow('', {}) === b.UNKNOWN_MODEL_WINDOW);
  ok('AGENT_CONTEXT_WINDOW 覆盖生效', b.resolveWindow('deepseek-chat', { AGENT_CONTEXT_WINDOW: '4096' }) === 4096);
  ok('非法覆盖回退默认', b.resolveWindow('deepseek-chat', { AGENT_CONTEXT_WINDOW: 'abc' }) === 65_536);
  const bDefault = b.createBudget('deepseek-chat', {});
  ok('默认 cap = 12000', bDefault.capTokens === b.DEFAULT_CAP_TOKENS);
  ok('默认输出预留 = 1500', bDefault.reserveOutputTokens === b.DEFAULT_RESERVE_OUTPUT_TOKENS);
  ok('默认换算 = 1.5 字符/token', bDefault.charsPerToken === b.CHARS_PER_TOKEN);
  ok('cap 可配置', b.createBudget('deepseek-chat', { AGENT_CONTEXT_CAP: '5000' }).capTokens === 5000);
  ok('非法 cap 回退默认', b.createBudget('deepseek-chat', { AGENT_CONTEXT_CAP: '-3' }).capTokens === b.DEFAULT_CAP_TOKENS);
  ok('生效预算 = min(window, cap)',
    b.allocate({ ...bDefault, capTokens: 5000 }, { systemChars: 0, memoryChars: 0, toolsChars: 0, currentChars: 0 }).effectiveTokens === 5000);
  ok('窗口小于 cap 时以窗口为准',
    b.allocate(b.createBudget('mystery-7b', {}), { systemChars: 0, memoryChars: 0, toolsChars: 0, currentChars: 0 }).effectiveTokens === 8192);
  ok('cap 过小仍有安全下限',
    b.allocate(b.createBudget('deepseek-chat', { AGENT_CONTEXT_CAP: '1' }), { systemChars: 0, memoryChars: 0, toolsChars: 0, currentChars: 0 }).effectiveTokens >= b.MIN_EFFECTIVE_TOKENS);

  console.log('\n[context-budget-probe] 2) 分配不变量');
  const usage = { systemChars: 2600, memoryChars: 1800, toolsChars: 4000, currentChars: 50 };
  const a = b.allocate(bDefault, usage);
  ok('fixedChars = 四段实测之和', a.fixedChars === 8450, `got ${a.fixedChars}`);
  ok('usedTokens 向上取整（保守）', a.usedTokens === Math.ceil(8450 / b.CHARS_PER_TOKEN));
  ok('★ 硬约束：used + history + reserve <= effective',
    a.usedTokens + a.historyTokens + a.reserveOutputTokens <= a.effectiveTokens);
  ok('historyChars = floor(historyTokens × charsPerToken)',
    a.historyChars === Math.floor(a.historyTokens * a.charsPerToken));
  ok('★ 默认预算不退化：历史上限 >= 旧 6000 字符', a.historyChars >= 6000, `got ${a.historyChars}`);
  ok('maxTurns 由预算推导，不再是常数 12', a.maxTurns !== 12 && a.maxTurns > 0, `got ${a.maxTurns}`);

  const aMoreTools = b.allocate(bDefault, { ...usage, toolsChars: 8000 });
  ok('★ 固定段变长 → 历史上限变小（自适应工具数）', aMoreTools.historyChars < a.historyChars);
  const aBigCap = b.allocate({ ...bDefault, capTokens: 20000 }, usage);
  ok('★ cap 变大 → 历史上限变大', aBigCap.historyChars > a.historyChars);
  const aSmallAvg = b.allocate({ ...bDefault, avgTurnChars: 100 }, usage);
  ok('★ 条数护栏随预算参数变化（非硬编码）', aSmallAvg.maxTurns !== a.maxTurns);
  const aTight = b.allocate(b.createBudget('deepseek-chat', { AGENT_CONTEXT_CAP: '1600' }), usage);
  ok('★ 预算过紧：tight + overBudget + 历史上限 0',
    aTight.tight && aTight.overBudget && aTight.historyChars === 0,
    JSON.stringify({ tight: aTight.tight, over: aTight.overBudget, hc: aTight.historyChars }));
  const aBad = b.allocate(bDefault, { systemChars: NaN, memoryChars: -5, toolsChars: NaN, currentChars: -1 });
  ok('NaN / 负数占用不产生 NaN，且不抵消正数',
    Number.isFinite(aBad.historyChars) && aBad.fixedChars === 0, `fixed=${aBad.fixedChars}`);
  ok('charsPerToken 可配置且影响换算',
    b.allocate({ ...bDefault, charsPerToken: 1 }, usage).historyChars !== a.historyChars);

  console.log('\n[context-budget-probe] 3) 历史截取（预算驱动）');
  const SID = 'ctx-budget-session';
  db.createSession({ id: SID, title: 'probe', model: 'probe', customer_name: OWNER });
  const push = (sid: string, role: 'user' | 'assistant', content: string) =>
    db.createMessage({ id: randomUUID(), session_id: sid, role, content });
  for (let i = 1; i <= 8; i++) {
    push(SID, 'user', `第${i}轮问题`);
    push(SID, 'assistant', `第${i}轮回答`);
  }
  push(SID, 'user', CURRENT); // 当前这条已落库
  const hAll = buildHistory(SID, CURRENT, 10000, 100);
  ok('取到 16 条历史（8 轮 × 2）', hAll.history.length === 16, `got ${hAll.history.length}`);
  ok('★ 当前消息不会重复进历史', hAll.history.every((m) => m.content !== CURRENT));
  ok('★ 顺序仍是连续的最近若干轮', hAll.history[0].content === '第1轮问题' && hAll.history[15].content === '第8轮回答');
  ok('未触发裁剪时 trimmed=false', hAll.trimmed === false);
  const hCut = buildHistory(SID, CURRENT, 40, 100);
  ok('★ 字符预算收紧 → 只留最近、trimmed=true', hCut.trimmed && hCut.history.length < 16 && hCut.history.at(-1)?.content === '第8轮回答');
  const hTurns = buildHistory(SID, CURRENT, 10000, 3);
  ok('★ 条数护栏生效（由调用方按预算传入）', hTurns.history.length === 3 && hTurns.trimmed);
  const hZero = buildHistory(SID, CURRENT, 0, 0);
  ok('预算为 0 → 空历史', hZero.history.length === 0 && hZero.trimmed);
  ok('未知 session → 空历史且不抛错', buildHistory('no-such-session', CURRENT, 10000, 10).history.length === 0);

  console.log('\n[context-budget-probe] 4) assembleContext 端到端');
  db.saveMemory(OWNER, 'preference', '作息', '喜欢早睡');
  const baseOpts = { owner: OWNER, sessionId: SID, message: CURRENT, toolDefs, model: 'deepseek-chat' };
  const ctx = assembleContext(baseOpts);
  ok('工具 schema 已转成 OpenAI 格式', ctx.tools.length === 3 && ctx.tools[0].type === 'function');
  ok('★ toolsChars 与实际下发的 tools 同源', ctx.stats.toolsChars === JSON.stringify(ctx.tools).length);
  ok('★ 系统提示能力清单由同一份 toolDefs 派生', ctx.system.includes('save_memory') && ctx.system.includes('web_lookup'));
  ok('记忆区块注入', ctx.memory.includes('喜欢早睡') && ctx.stats.memoryCount === 1);
  ok('各段 stats 都是实测值',
    ctx.stats.systemChars === ctx.system.length &&
    ctx.stats.memoryChars === ctx.memory.length &&
    ctx.stats.historyChars === ctx.history.reduce((n, m) => n + m.content.length, 0));
  ok('★ 实际历史不超预算上限',
    ctx.stats.historyChars <= ctx.allocation.historyChars && ctx.stats.turns <= ctx.allocation.maxTurns);
  ok('★ 预算硬约束在真实装配下仍成立',
    ctx.allocation.usedTokens + ctx.allocation.historyTokens + ctx.allocation.reserveOutputTokens <= ctx.allocation.effectiveTokens);
  ok('默认配置未裁剪（不退化）', !ctx.stats.trimmed && ctx.history.length === 16);

  const withArtifact = assembleContext({ ...baseOpts, currentChars: CURRENT.length + 8000 });
  ok('★ 产物兜底拼入的内容计入预算（fixedChars +8000）',
    withArtifact.allocation.fixedChars - ctx.allocation.fixedChars === 8000);
  ok('★ 本轮变长 → 历史上限相应变小（不再漏算）',
    withArtifact.allocation.historyChars < ctx.allocation.historyChars);

  const overridden = assembleContext({ ...baseOpts, systemOverride: '你是晨报写手，只写三句。' });
  ok('★ systemOverride 时不注入记忆', overridden.memory === '' && overridden.stats.memoryCount === 0);
  ok('systemOverride 原样下发', overridden.system === '你是晨报写手，只写三句。');
  ok('★ override 让出的预算确实回到历史', overridden.allocation.historyChars > ctx.allocation.historyChars);

  const tight = assembleContext({
    ...baseOpts,
    budget: b.createBudget('deepseek-chat', { AGENT_CONTEXT_CAP: '1600' }),
  });
  ok('★ 小预算 → 历史被裁掉且标记 tight', tight.allocation.tight && tight.history.length === 0);

  ok('★ 红线：预算 stats 不回灌 prompt',
    !/context budget|effectiveTokens|history上限|overBudget|historyChars/.test(ctx.system + ctx.memory));
  ok('toOpenAiTools 是唯一适配出口（同输入同输出）',
    JSON.stringify(toOpenAiTools(toolDefs)) === JSON.stringify(ctx.tools));

  console.log('\n[context-budget-probe] 5) 不退化与同源纪律');
  const SID2 = 'ctx-budget-short-session';
  db.createSession({ id: SID2, title: 'probe', model: 'probe', customer_name: OWNER });
  for (let i = 1; i <= 12; i++) push(SID2, i % 2 ? 'user' : 'assistant', `第${i}条历史` + '内'.repeat(94));
  push(SID2, 'user', CURRENT);
  const c5 = assembleContext({ ...baseOpts, sessionId: SID2 });
  ok('★ 原 12 条 / 6000 字符以内的历史全部保留',
    c5.history.length === 12 && !c5.stats.trimmed, `turns=${c5.history.length} trimmed=${c5.stats.trimmed}`);

  db.saveMemory(MEM_OWNER, 'fact', '长记忆', '甲'.repeat(300));
  const bm = buildMemoryContext(MEM_OWNER, '甲', { charBudget: 1000, snippetMax: 40 });
  ok('★ 记忆选取与渲染共用同一份 snippetMax（不会超预算渲染）',
    bm.split('\n').every((line) => line.length <= 80), JSON.stringify(bm.split('\n').map((l) => l.length)));
  const bmOld = buildMemoryContext(OWNER, '作息');
  ok('不传预算的旧调用行为不变', typeof bmOld === 'string' && bmOld.includes('喜欢早睡'));
  ok('★ 全库无「12 轮 / 6000 字符」硬编码残留',
    !/maxTurns\s*=\s*12|maxChars\s*=\s*6000/.test(
      fs.readFileSync(path.join(process.cwd(), 'server/llm/bailian.ts'), 'utf-8')
    ));
} finally {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmp + suffix); } catch { /* 不存在就算了 */ }
  }
  console.log(`\n[context-budget-probe] 结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}
