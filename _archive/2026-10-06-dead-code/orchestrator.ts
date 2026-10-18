/**
 * 星澜 · 多 Agent 编排层（Supervisor + 4 角色）
 * 把「单 Agent 一肩挑」升级为分工协作：
 *   Planner（规划）→ Researcher（研究/联网）→ Executor（执行/产物）→ Critic（复核）
 * 每个角色都是一次 runBailianAgentTurn 调用，复用同一套 AgentEvent 契约与工具执行器，
 * 通过 systemOverride 注入角色职责、通过 role 字段在事件上打标签（前端据此做角色标签）。
 * 简单任务（记提醒/心情/闲聊）仍走单 Agent（role=executor），避免无谓的多倍开销。
 *
 * 成本与延迟控制：
 *   - 仅「复杂任务」走多 Agent 编排；复杂判定用关键词 + intent。
 *   - 子角色 maxIter 收紧（默认 3），避免 context 爆炸。
 *   - 编排层只记一次 agent_runs（子角色 skipRecord）。
 */
import type { AgentTurnOptions, AgentEvent } from '../agent.js';
import { buildSystemPrompt, buildMemoryContext } from '../agent.js';
import { runBailianAgentTurn } from './bailian.js';
import * as db from '../db.js';
import { isWebSearchConfigured } from '../tools/web.js';

type Role = 'planner' | 'researcher' | 'executor' | 'critic';

const ROLE_PROMPTS: Record<Role, string> = {
  planner: `你是星澜的「规划师」子智能体。先把用户的诉求拆成清晰的执行步骤，判断：
- 是否需要联网研究（查攻略/天气/新闻/政策/实时信息）；
- 是否需要生成可留存的结构化产物（行程卡 itinerary / 报告 report / 清单 checklist）。
只输出规划（步骤 + 研究要点 + 产物构思），不要执行任何动作、不要调用工具。`,
  researcher: `你是星澜的「研究员」子智能体。基于规划，调用 web_lookup 检索真实一手信息并归纳关键结论。
只做研究、不执行动作（不记记忆/不设提醒）。若当前环境未配置联网，如实说明无法检索。`,
  executor: `你是星澜的「执行者」子智能体。按规划与研究成果，调用工具真正落实：
- 该记的记（save_memory）、该提醒的设（set_reminder）；
- 该交付的产物用 create_artifact 生成（行程卡/报告/清单），内容要具体可接手。
这是最终交付给用户的内容，语言要自然、像朋友，但结论要 concrete。`,
  critic: `你是星澜的「复核员」子智能体。审视规划 / 研究 / 执行结果与产物，指出明显错误、遗漏或风险，2-3 句即可；
若产物（artifact）有明显问题，可调用 update_artifact 修正。不要重复执行，只做质量把关。`,
};

function roleSystem(role: Role, base: string): string {
  return `${base}\n\n# 你当前的角色：${ROLE_PROMPTS[role]}`;
}

/** 复杂任务判定：需要规划/研究/多步协作才值得多 Agent 编排 */
function isComplex(opts: AgentTurnOptions): boolean {
  const m = String(opts.message || '');
  // 纯检索/单轮答疑（天气/新闻/股价/百科/怎么做…）不进重编排，单 Agent 一次联网即可
  const isPureLookup = /(查一下|查查|搜一下|搜索|天气|气温|几度|多少度|新闻|股价|汇率|最新|今天|今晚|明天|后天|攻略|怎么走|怎么做|怎么用|怎么去|百科|政策|报价)/.test(m);
  const hasPlanWord = /(规划|行程|旅游|出游|周末|假期|方案|报告|对比|研究|调研|清单|计划|安排|路线|餐厅|玩法|怎么玩|去哪|总结|盘点|整理|行程卡)/.test(m);
  if (isPureLookup && !hasPlanWord) return false;
  if (opts.intent === 'travel' || opts.intent === 'knowledge') return true;
  return hasPlanWord;
}

function collectText(chunk: AgentEvent): string {
  return chunk.type === 'text' ? chunk.content : '';
}

function collectTools(chunk: AgentEvent): string[] {
  if (chunk.type === 'tool' || chunk.type === 'tool_result') return [chunk.name];
  return [];
}

/**
 * 多 Agent 编排入口：与 runBailianAgentTurn 同签名、同事件契约。
 * 复杂任务走 Planner→Researcher→Executor→Critic，简单任务退化为单 Agent。
 */
export async function* runOrchestratedAgentTurn(opts: AgentTurnOptions): AsyncGenerator<AgentEvent> {
  const owner = opts.customerName || 'guest';
  const base = buildSystemPrompt(buildMemoryContext(owner));
  const complex = isComplex(opts);

  // 简单任务：单 Agent 直接干（role=executor，行为与原生一致）
  if (!complex) {
    yield* runBailianAgentTurn({ ...opts, role: 'executor', skipRecord: false });
    return;
  }

  const allTools = new Set<string>();
  let plannerText = '';
  let researchText = '';
  let executorText = '';

  const track = (chunk: AgentEvent) => {
    plannerText += collectText(chunk);
    if (chunk.type !== 'artifact') for (const t of collectTools(chunk)) allTools.add(t);
  };

  // 1) Planner
  for await (const ev of runBailianAgentTurn({
    ...opts,
    role: 'planner',
    systemOverride: roleSystem('planner', base),
    maxIter: 2,
    skipRecord: true,
  })) {
    track(ev);
    // 规划师的内部规划文本不暴露给用户（星澜是「在场的存在」，不是汇报机器）
    if (ev.type !== 'text') yield ev;
  }

  // 2) Researcher（仅当联网可用，否则跳过该角色，由 Planner/Executor 凭已有知识兜底）
  if (isWebSearchConfigured()) {
    const researchMsg = `用户诉求：${opts.message}\n\n【规划】\n${plannerText}\n\n请联网检索真实信息并归纳关键结论，支撑后续执行。`;
    for await (const ev of runBailianAgentTurn({
      ...opts,
      role: 'researcher',
      systemOverride: roleSystem('researcher', base),
      message: researchMsg,
      maxIter: 3,
      skipRecord: true,
    })) {
      researchText += collectText(ev);
      if (ev.type !== 'artifact') for (const t of collectTools(ev)) allTools.add(t);
      // 研究员的研究过程不暴露给用户，只留结论给 Executor 复用
      if (ev.type !== 'text') yield ev;
    }
  }

  // 3) Executor（落实 + 生成产物）
  const execMsg = `用户诉求：${opts.message}\n\n【规划】\n${plannerText}\n\n${
    researchText ? `【研究结论】\n${researchText}\n\n` : ''
  }请据此调用工具落实，并生成可留存的结构化产物（如行程卡）。`;
  for await (const ev of runBailianAgentTurn({
    ...opts,
    role: 'executor',
    systemOverride: roleSystem('executor', base) + '\n\n注意：不要重复调用 web_lookup，联网研究已由「研究员」完成，直接复用【研究结论】组织回答。',
    message: execMsg,
    maxIter: 3,
    omitTools: ['web_lookup'],
    skipRecord: true,
  })) {
    executorText += collectText(ev);
    if (ev.type !== 'artifact') for (const t of collectTools(ev)) allTools.add(t);
    yield ev;
  }

  // 4) Critic（复核，可修正产物）
  const criticMsg = `用户诉求：${opts.message}\n\n【规划】\n${plannerText}\n\n${
    researchText ? `【研究结论】\n${researchText}\n\n` : ''
  }【执行结果】\n${executorText}\n\n请做简短质量与风险复核；若产物有误可调用 update_artifact 修正。`;
  let criticText = '';
  for await (const ev of runBailianAgentTurn({
    ...opts,
    role: 'critic',
    systemOverride: roleSystem('critic', base),
    message: criticMsg,
    maxIter: 2,
    skipRecord: true,
  })) {
    criticText += collectText(ev);
    if (ev.type !== 'artifact') for (const t of collectTools(ev)) allTools.add(t);
    // 复核员文本不暴露给用户（质量把关在后端完成，不污染对话）
    if (ev.type !== 'text') yield ev;
  }

  // 统一记录一次活动流（多 Agent 协作视为一次自主动作）
  try {
    db.addAgentRun({
      session_id: opts.sessionId,
      prompt: String(opts.message || ''),
      intent: opts.intent,
      tools_used: Array.from(allTools).join(','),
      outcome: 'handled',
      model: 'bailian-orchestrator',
    });
  } catch {
    /* 遥测失败不影响主流程 */
  }

  yield {
    type: 'done',
    fullText: executorText.trim(),
    intent: opts.intent,
    toolsUsed: Array.from(allTools),
    fallback: false,
  };
}
