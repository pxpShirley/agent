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
 *
 * 零成本：不调任何真实 API；临时库，跑完即删。
 * 红线自检：事实只用于生成 prompt 与只读观测，不把 trace 文本回灌上下文。
 *
 * 运行：npx tsx scripts/briefing-probe.ts   （已串入 `npm test`）
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

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
  maybeAgent,
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
  ok('★ 文案落地可被启发式判中', goalEchoed(c.body, f.goals));
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
