/**
 * 回归探针：晨报/复盘「统一事实层 + 自由表达层」（2026-11-07）
 *
 * 背景（为什么必须有这个探针）：
 *   F2 生活教练层的愿望原来只在模板路径里出现。模型路径（AGENT_BRIEFING=1）
 *   只靠 buildMemoryContext(owner, prompt) 取记忆，而检索 query 是「写一段今日
 *   晨报」这类生成指令，与「理想状态：想每天早起跑步」几乎零字面向合 →
 *   愿望根本进不了模型。系统提示词却承诺「你会在晨报里陪他朝它迈一小步」。
 *   缺陷藏得很深：晨报看着完全正常，只是不再提那个愿望。
 *
 * 验证点：
 *   1) collectBriefingFacts：愿望/待办/情绪/记忆/反馈一次取全
 *   2) buildBriefingPrompt（morning/weekly）：含愿望 + 含推进指令，但**不含模板句式**
 *   3) prompt 含待办、记忆等其他事实（证明注入的是事实层，不是只补了 goals）
 *   4) 无愿望用户：prompt 明确禁止编造目标，且不出现愿望段落
 *   5) 模板路径输出逐字不变（重构不能碰坏默认路径）
 *   6) goalEchoed 启发式：命中/不命中/空候选
 *   7) 端到端：注入假生成器驱动**模型路径**，断言愿望真的进了 prompt、文案真的落地
 *   8) 兜底路径仍在：关闭开关 / 生成器抛错时都回退模板（凭证耗尽、离线不能没有主动服务）
 *   9) F2 四层证据：材料(确定性)/词面(启发式)/提议(启发式)/行为(pending)，
 *      且生成时刻绝不伪造一个还不存在的行为结果
 *  10) 事后关联：card_id join proactive_feedback；无反馈是「暂无信号」不是负面；
 *      整卡反馈不能归因到 F2 单行
 *  11) 分布健康度（古德哈特定律）：生成侧指标恒真 = 被刷到失去分辨力；
 *      模板恒真不污染模型路径判定；无信号率以全样本为分母；旧 span 跳过；
 *      时间窗过滤；生成侧饱和 + 用户侧走低 → 背离告警
 *
 * 零成本：不调任何真实 API；临时库，跑完即删。
 * 红线自检：事实只用于生成 prompt 与只读观测，不把 trace 文本回灌上下文。
 *
 * 运行：npx tsx scripts/briefing-probe.ts   （已串入 `npm test`）
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

const tmp = path.join(os.tmpdir(), `briefing-probe-${Date.now()}.db`);
process.env.CHAT_DB_PATH = tmp;

// ⚠️ 必须在 import 数据层之前设 CHAT_DB_PATH（静态不 import 任何 server 模块）
const db = await import('../server/db.js');
const {
  collectBriefingFacts,
  buildBriefingPrompt,
  buildMorning,
  buildWeekly,
  goalEchoed,
  goalNudgePresent,
  maybeAgent,
  tick,
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

const OWNER = 'briefing-probe-owner';
const EMPTY_OWNER = 'briefing-probe-no-goal';
const GOAL = '想每天早起跑步';
const saved = {
  AGENT_BRIEFING: process.env.AGENT_BRIEFING,
  BAILIAN_API_KEY: process.env.BAILIAN_API_KEY,
  DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
};

try {
  // ---- seed ----
  db.saveMemory(OWNER, 'plan', '理想状态', GOAL);
  db.saveMemory(OWNER, 'preference', '作息', '喜欢早睡');
  db.addReminder(OWNER, '交项目报告', new Date(Date.now() + 86400000).toISOString());
  db.addMood(OWNER, 4, '状态不错');
  db.saveMemory(EMPTY_OWNER, 'fact', '城市', '在深圳');

  console.log('\n[briefing-probe] 1) collectBriefingFacts 事实层');
  const f = collectBriefingFacts(OWNER);
  ok('挑到 1 条愿望候选', f.goals.length === 1, JSON.stringify(f.goals));
  ok('愿望内容正确', f.goals[0]?.value === GOAL);
  ok('待办数正确', f.pendingCount === 1, `got ${f.pendingCount}`);
  ok('记忆数 >= 2', f.memoryCount >= 2, `got ${f.memoryCount}`);
  ok('情绪均值已取', f.moodAvg !== null);
  ok('最近心情已取', f.lastMoodLevel === 4);

  console.log('\n[briefing-probe] 2) morning/weekly prompt 含事实但不含模板句式');
  const pm = buildBriefingPrompt(OWNER, 'morning', f);
  const pw = buildBriefingPrompt(OWNER, 'weekly', f);
  ok('morning 含愿望原文', pm.includes(GOAL));
  ok('weekly 含愿望原文', pw.includes(GOAL));
  ok('morning 含「最小一步」推进指令', pm.includes('最小一步'));
  ok('weekly 含行动建议要求', pw.includes('行动建议'));
  ok('morning 不含模板句式', !pm.includes('你说过想「'), '模型不该照抄模板');
  ok('weekly 不含模板句式', !pw.includes('这周有没有往前挪一点点'));
  ok('morning 明确禁止编造', pm.includes('不要编造'));
  ok('两条 prompt 不同（分场景）', pm !== pw);

  console.log('\n[briefing-probe] 3) 注入的是完整事实层，不是只补 goals');
  ok('含待办事实', pm.includes('未完成 1 件'), pm.slice(0, 260));
  ok('含记忆事实', pm.includes('已记录记忆'));
  ok('含情绪事实', pm.includes('情绪均值'));
  ok('含用户记忆条目', pm.includes('喜欢早睡') || pm.includes('理想状态'));

  console.log('\n[briefing-probe] 4) 无愿望用户：不编造目标');
  const fe = collectBriefingFacts(EMPTY_OWNER);
  const pe = buildBriefingPrompt(EMPTY_OWNER, 'morning', fe);
  ok('候选为空', fe.goals.length === 0);
  ok('prompt 禁止编造愿望', pe.includes('绝不要凭空编造一个'));
  ok('prompt 无愿望段落', !pe.includes('用户说过的愿望/目标'));

  console.log('\n[briefing-probe] 5) 模板路径输出不变（默认路径回归）');
  const tm = buildMorning(OWNER).body;
  const tw = buildWeekly(OWNER).body;
  ok('晨报仍带 F2 固定句', tm.includes(`你说过想「${GOAL}」——今天要不要先迈出最小的一步？`), tm);
  ok('复盘仍带 F2 固定句', tw.includes('这周有没有往前挪一点点'));
  ok('晨报仍以邀约收尾', tm.includes('今天想让我帮你做点什么'));
  ok('复盘仍以邀约收尾', tw.includes('新的一周，想先搞定哪件事'));
  ok('无愿望用户模板不提愿望', !buildMorning(EMPTY_OWNER).body.includes('你说过想'));

  console.log('\n[briefing-probe] 6) goalEchoed 启发式');
  ok('自己的话提到「早起」→ 命中', goalEchoed('今天要不要先从早起十分钟开始？', f.goals));
  ok('完全无关 → 不命中', !goalEchoed('今天天气不错，记得带伞', f.goals));
  ok('空候选 → false', !goalEchoed('随便说点什么', []));

  console.log('\n[briefing-probe] 7) 端到端：注入生成器驱动模型路径（零 API 调用）');
  process.env.AGENT_BRIEFING = '1';
  process.env.BAILIAN_API_KEY = 'probe-fake-no-network';
  delete process.env.DEEPSEEK_API_KEY;
  let captured = '';
  const fakeGen = async function* (prompt: string) {
    captured = prompt;
    yield { type: 'text' as const, content: '今天要不要先从早起十分钟开始？' };
  };
  const c = await maybeAgent(OWNER, 'morning', () => buildMorning(OWNER), fakeGen);
  ok('确实走了模型路径', c.viaAgent === true);
  ok('body 是模型文案而非模板', c.body === '今天要不要先从早起十分钟开始？', c.body);
  ok('★ 愿望确实进了模型 prompt（F2 不再被绕过）', captured.includes(GOAL), captured.slice(0, 300));
  ok('★ prompt 含推进指令', captured.includes('最小一步'));
  ok('★ 词面层可被启发式判中（仅证明词出现，不代表用户感知）', goalEchoed(c.body, f.goals));
  ok('模型路径不夹带模板句式', !captured.includes('你说过想「'));

  const cw = await maybeAgent(OWNER, 'weekly', () => buildWeekly(OWNER), async function* (prompt: string) {
    captured = prompt;
    yield { type: 'text' as const, content: '这周先从跑步一公里试试？' };
  });
  ok('weekly 模型路径同样注入愿望', cw.viaAgent === true && captured.includes(GOAL));

  console.log('\n[briefing-probe] 8) 兜底路径仍在（可靠性）');
  process.env.AGENT_BRIEFING = '0';
  const c0 = await maybeAgent(OWNER, 'morning', () => buildMorning(OWNER), fakeGen);
  ok('关闭开关 → 回退模板', c0.viaAgent === false && c0.body === tm);
  process.env.AGENT_BRIEFING = '1';
  const cErr = await maybeAgent(OWNER, 'morning', () => buildMorning(OWNER), async function* () {
    throw new Error('quota 403');
  });
  ok('凭证/生成失败 → 回退模板', cErr.viaAgent === false && cErr.body === tm);

  console.log('\n[briefing-probe] 9) 提议层判据 + 生成时刻四层证据');
  ok('模板句命中提议层', goalNudgePresent(`你说过想「${GOAL}」——今天要不要先迈出最小的一步？`));
  ok('模型自然句命中提议层', goalNudgePresent('今天要不要先从早起十分钟开始？'));
  ok('★ 纯提及不命中（避免把「记得早起」当教练）', !goalNudgePresent('今天天气不错，记得早起'));
  ok('空文案 → false', !goalNudgePresent(''));

  // 关掉模型路径，防止 tick 意外触发真实网络请求
  process.env.AGENT_BRIEFING = '0';
  delete process.env.BAILIAN_API_KEY;
  db.createSession({ id: 'briefing-probe-session', title: 'probe', model: 'probe', customer_name: OWNER });
  await tick();
  const schedRuns = db
    .getAgentRuns(50)
    .filter((r: any) => r.source === 'proactive' && (r.prompt || '').includes(`owner=${OWNER}`));
  const allSpans = schedRuns.flatMap((r: any) => db.getRunTrace(r.id));
  const f2Span = allSpans.find(
    (s: any) => (s.args_json || '').includes('"card_id"') && (s.text || '').includes('F2候选')
  ) as any;
  ok('★ 生成了带 card_id 的 F2 span', !!f2Span, `spans=${allSpans.length}`);
  if (f2Span) {
    const t = String(f2Span.text || '');
    ok('材料层标注确定性', t.includes('材料=已注入(确定性)'));
    ok('词面层标注启发式', t.includes('词面=') && t.includes('(启发式)'));
    ok('提议层独立成层', t.includes('提议=') && t.includes('(启发式)'));
    ok('★ 不再用「文案落地」冒充用户感知', !t.includes('文案落地'));
    ok('★ 明确写用户感知不可测', t.includes('用户感知=不可测'));
    const meta = JSON.parse(String(f2Span.args_json));
    ok('结构化证据含 card_id', typeof meta.card_id === 'string' && meta.card_id.length > 0);
    ok('材料层 facts_injected=true', meta.facts_injected === true);
    ok('词面/提议层为布尔', typeof meta.goal_mentioned === 'boolean' && typeof meta.nudge_present === 'boolean');
    ok('★ 行为层生成时刻恒 pending（不伪造时序）', meta.user_response === 'pending');
    ok('★ 携带归因 caveat', String(meta.caveat || '').includes('不能归因'));

    console.log('\n[briefing-probe] 10) card_id 事后关联（只读）');
    let outs = db.getF2Outcomes(OWNER, 50);
    const row = outs.find((o: any) => o.card_id === meta.card_id);
    ok('卡片出现在 outcomes', !!row, `rows=${outs.length}`);
    if (row) {
      ok('★ 无反馈 = none（不是负面）', row.response === 'none' && row.responded_at === null);
      ok('生成证据已 join 到结果行', row.goal_mentioned === meta.goal_mentioned && row.nudge_present === meta.nudge_present);
      ok('路径已关联', row.path === 'template');
      db.recordProactiveFeedback(OWNER, meta.card_id, 'morning', 'seen');
      db.recordProactiveFeedback(OWNER, meta.card_id, 'morning', 'dismissed');
      outs = db.getF2Outcomes(OWNER, 50);
      const rowsForCard = outs.filter((o: any) => o.card_id === meta.card_id);
      ok('多次反馈只出一行（不重复计数）', rowsForCard.length === 1, `rows=${rowsForCard.length}`);
      ok('★ 事后行为被关联（seen/dismissed 之一）',
        rowsForCard[0] && (rowsForCard[0].response === 'seen' || rowsForCard[0].response === 'dismissed'));
      ok('行为发生时间已回填', rowsForCard[0] && !!rowsForCard[0].responded_at);
    }
  }
  ok('未知 owner 的 outcomes 为空', db.getF2Outcomes('no-such-owner').length === 0);

  console.log('\n[briefing-probe] 11) 分布健康度：指标恒真是退化，不是变好');
  const STATS_OWNER = 'stats-probe-owner';
  const sqlite = (db as any).default;
  const seedSpan = (fields: Record<string, unknown>) => {
    const runId = randomUUID();
    const cardId = randomUUID();
    db.addAgentRun({ id: runId, prompt: 'stats-probe', intent: 'proactive', model: 'scheduler', source: 'proactive' });
    db.addAgentSpans(runId, [{
      phase: 'intent',
      text: 'stats probe span',
      args_json: JSON.stringify({
        card_id: cardId, kind: 'morning', path: 'model',
        facts_injected: true, goal_mentioned: true, nudge_present: true,
        user_response: 'pending', ...fields,
      }),
    }]);
    return { runId, cardId };
  };

  const s0 = db.getF2Stats(30);
  const model0 = s0.byPath.find((p: any) => p.path === 'model')?.samples || 0;
  const tpl0 = s0.byPath.find((p: any) => p.path === 'template')?.samples || 0;
  ok('刻意不返回单一「有效率」字段', !('effectiveRate' in s0) && !('successRate' in s0));

  // 阶段 A：6 条模型路径全命中 → 提议率 100%，应当被判为「饱和/已被刷」
  const modelCards: Array<{ runId: string; cardId: string }> = [];
  for (let i = 0; i < 6; i++) modelCards.push(seedSpan({}));
  db.recordProactiveFeedback(STATS_OWNER, modelCards[0].cardId, 'morning', 'seen');
  for (let i = 1; i <= 3; i++) db.recordProactiveFeedback(STATS_OWNER, modelCards[i].cardId, 'morning', 'dismissed');
  const sA = db.getF2Stats(30);
  const mA: any = sA.byPath.find((p: any) => p.path === 'model');
  ok('模型路径样本按增量计入', mA && mA.samples === model0 + 6, `got ${mA?.samples}`);
  ok('提议率 = 100%', mA && mA.nudgeRate === 1);
  ok('★ 恒真被判为饱和（不是「效果好」）', mA && mA.saturated === true);
  ok('★ 行为分布：收下 1 / 划掉 3 / 暂无信号 2',
    mA && mA.seen === 1 && mA.dismissed === 3 && mA.noSignal === 2,
    JSON.stringify({ seen: mA?.seen, dismissed: mA?.dismissed, noSignal: mA?.noSignal }));
  ok('★ 无信号率以全样本为分母（2/6）', mA && Math.abs(mA.noSignalRate - 2 / 6) < 1e-9);
  ok('★ 生成侧饱和 + 用户侧走低 → 背离告警', sA.divergence === 'suspicious');

  // 阶段 B：模板路径恒真是设计使然，绝不能污染模型路径的饱和判定
  for (let i = 0; i < 6; i++) seedSpan({ path: 'template' });
  const sB = db.getF2Stats(30);
  const mB: any = sB.byPath.find((p: any) => p.path === 'model');
  const tB: any = sB.byPath.find((p: any) => p.path === 'template');
  ok('模板样本单独成组', tB && tB.samples === tpl0 + 6, `got ${tB?.samples}`);
  ok('★ 模板恒真标为预期内，不算告警', tB && tB.expectedSaturation === true && tB.saturated === false);
  ok('★ 模板恒真未污染模型路径判定', mB && mB.saturated === true && mB.samples === model0 + 6);

  // 阶段 C：掺入 3 条未命中 → 不再饱和，背离告警解除
  for (let i = 0; i < 3; i++) seedSpan({ nudge_present: false });
  for (let i = 0; i < 3; i++) seedSpan({ nudge_present: true });
  const sC = db.getF2Stats(30);
  const mC: any = sC.byPath.find((p: any) => p.path === 'model');
  ok('混合后提议率降至 0.75', mC && Math.abs(mC.nudgeRate - 0.75) < 1e-9, `got ${mC?.nudgeRate}`);
  ok('★ 不再饱和，告警解除', mC && mC.saturated === false && sC.divergence === 'none');

  // 阶段 C2：无愿望候选的卡片不能算「提议失败」（分母口径）
  const sBeforeNoCand = db.getF2Stats(30);
  const mBeforeNoCand: any = sBeforeNoCand.byPath.find((p: any) => p.path === 'model');
  seedSpan({ facts_injected: false, goal_mentioned: false, nudge_present: false });
  const sAfterNoCand = db.getF2Stats(30);
  const mAfterNoCand: any = sAfterNoCand.byPath.find((p: any) => p.path === 'model');
  ok('★ 无候选样本计入总样本', mAfterNoCand.samples === mBeforeNoCand.samples + 1);
  ok('★ 但不进提议率分母', mAfterNoCand.eligible === mBeforeNoCand.eligible && mAfterNoCand.noCandidate === mBeforeNoCand.noCandidate + 1);
  ok('★ 提议率不被稀释', mAfterNoCand.nudgeRate === mBeforeNoCand.nudgeRate,
    `${mBeforeNoCand.nudgeRate} -> ${mAfterNoCand.nudgeRate}`);

  // 阶段 D：旧格式 span 跳过（不能当成 false，否则历史全被算成未命中）；时间窗过滤
  const beforeStale = db.getF2Stats(30);
  const staleRun = randomUUID();
  db.addAgentRun({ id: staleRun, prompt: 'old-format', intent: 'proactive', model: 'scheduler', source: 'proactive' });
  db.addAgentSpans(staleRun, [{
    phase: 'intent', text: 'old', args_json: JSON.stringify({ card_id: randomUUID(), path: 'model' }),
  }]);
  const sD = db.getF2Stats(30);
  ok('★ 旧格式 span 被跳过而非计为未命中',
    sD.total === beforeStale.total && sD.staleSpansSkipped === beforeStale.staleSpansSkipped + 1,
    `total ${beforeStale.total}->${sD.total} skipped ${beforeStale.staleSpansSkipped}->${sD.staleSpansSkipped}`);
  const oldIso = new Date(Date.now() - 45 * 86_400_000).toISOString();
  sqlite.prepare('UPDATE agent_spans SET created_at = ? WHERE run_id = ?').run(oldIso, modelCards[5].runId);
  const s30 = db.getF2Stats(30);
  const s60 = db.getF2Stats(60);
  ok('★ 45 天前的样本被 30 天窗口排除、被 60 天窗口纳入',
    s30.total === s60.total - 1, `30d=${s30.total} 60d=${s60.total}`);
  ok('days 被夹到合法范围', db.getF2Stats(0).days >= 1 && db.getF2Stats(9999).days <= 365);
} finally {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmp + suffix); } catch { /* 不存在就算了 */ }
  }
  console.log(`\n[briefing-probe] 结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}
