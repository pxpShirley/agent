/**
 * 星澜 · Agent 运行时（大脑）
 * 提供提示词构建 + 演示态本地规则引擎（runMockAgentTurn）。
 *
 * 真实大模型对话由 `server/llm/bailian.ts` 承担（OpenAI 兼容，DeepSeek / 百炼）。
 * 原 CodeBuddy SDK 引擎（@tencent-ai/agent-sdk 的 query()）已于 2026-10-06 移除：
 * SDK 在本机 `initialize` 即超时、完全不可用，且维护成本高于收益。
 * 若将来要接回，需重新引入 SDK 并新增一个实现 AgentEvent 契约的 generator。
 *
 * === 对齐参考架构 L1 Agent Loop（六步 ReAct 循环）===
 * ① 分析上下文 → ② 推理决策 → ③ 选择工具 → ④ 执行动作
 * → ⑤ 观察结果 → ⑥ 判断完成 → ✅ 交付
 * MAX_AGENT_ITERATIONS 为最大循环次数（防 context 爆炸/无限循环）。
 */
import './env.js';
import * as db from './db.js';
import type { IntentCode } from './db.js';
import { webSearch } from './tools/web.js';
import { syncReminder } from './actions/outbound.js';
import { selectMemories, formatMemoryLine } from './memory.js';

/**
 * 记忆候选池大小：不是注入量，是「参与打分的候选数」。
 * 取 60 是为了让老记忆也有机会被相关性捞回来（预算只限制最终注入多少）。
 */
const MEMORY_CANDIDATE_POOL = 60;

/** 最大循环/迭代次数（对齐参考架构「最大循环次数 + 上下文压缩」，防无限循环） */
export const MAX_AGENT_ITERATIONS = 6;

export type AgentEvent =
  | { type: 'text'; content: string; role?: string }
  | { type: 'tool'; name: string; input: unknown; role?: string }
  | { type: 'tool_result'; name: string; ok: boolean; role?: string }
  | { type: 'ask_user'; id: string; question: string; options: string[] | null; action_json?: string | null; role?: string }
  | {
      type: 'artifact';
      id: string;
      title: string;
      artifactType: string;
      action: 'created' | 'updated';
    }
  | { type: 'done'; fullText: string; intent: IntentCode; toolsUsed: string[]; fallback: boolean; error?: string; sdkSessionId?: string; role?: string };

export interface AgentTurnOptions {
  sessionId: string;
  message: string;
  model?: string;
  customerName?: string;
  intent: IntentCode;
  sdkSessionId?: string;
  /** 多 Agent：本角色专属 system 前缀（覆盖默认人设） */
  systemOverride?: string;
  /** 多 Agent：本角色名（planner/researcher/executor/critic），透传到前端做角色标签 */
  role?: string;
  /** 多 Agent 编排层调用时，跳过内部 agent_runs 记录（由编排层统一记一次） */
  skipRecord?: boolean;
  /** 子 Agent 最大迭代轮次（编排层可为子角色收紧，避免成本爆炸） */
  maxIter?: number;
  /** 子 Agent 工具集裁剪（编排层让 Executor 不复用联网工具时使用） */
  omitTools?: string[];
}

/**
 * 组装注入提示词的记忆区块。
 *
 * 2026-10-08 重构：原来是「取最近 12 条 + 每条截断 160 字符」——条数是常数，
 * 与本轮问什么无关，也与每条多长无关。长记忆会挤掉短记忆，陈旧的高频记忆会挤掉刚记住的。
 * 现在改为 **相关性排序 + 字符预算贪心截断**（实现在 server/memory.ts，与 recall_memory 同源）：
 *   注入量 = min(相关性截断后的条数, 字符预算允许的条数)
 *
 * @param query 本轮用户原话。**必须传**——不传就退化成旧的「取最近 N 条」，
 *   预注入就失去了意义（模型还是得再调一次 recall_memory 才能拿到相关的）。
 */
export function buildMemoryContext(owner: string, query = ''): string {
  const rows = db.getMemories(owner, MEMORY_CANDIDATE_POOL);
  if (!rows.length) return '（暂无记录，可在对话中逐步了解这位用户）';
  const picked = selectMemories(rows, query);
  return picked.length ? picked.map((r) => formatMemoryLine(r)).join('\n') : '（暂无记录，可在对话中逐步了解这位用户）';
}

/**
 * 组装系统提示词。
 * @param capabilities **必须**传入本次请求实际下发给模型的工具名列表（与 tools 数组同源）。
 *   绝不要另取一份静态清单——曾经提示词写 6 项、运行时发 10 项，导致产物三件套
 *   （open/create/update_artifact）落在「清单之外」而被模型自我禁止调用。
 */
export function buildSystemPrompt(memoryContext: string, capabilities: string[]): string {
  return `你是「星澜」，一位全天候在线的 AI 生活管家。用简体中文、自然亲切、像朋友一样和用户聊天；既能答疑也能陪伴，更能真正替用户把事情办了。

**语言硬要求：全程只用简体中文**，包括思考过程、工具调用前后的过渡句、报错说明。绝不夹带英文句子（如 "I'll look that up"、"Let me check"）——要说就说「我帮你查一下」。

# 你的能力（通过工具调用完成，不要凭空编造）
- 记住关于用户的事（核心职责）：用户透露偏好/习惯/计划/事实或说「记住」时，先调 save_memory 存下；recall_memory 在需要回看时调用
- 管理提醒与日程：set_reminder / get_schedule（空库时直接给方案即可，不必特意去查）
- 情绪陪伴：用户倾诉时先共情，必要时 checkin_mood 记录
- 查资料：web_lookup（实时联网检索最新资讯；联网失败会如实告知，不要假装已联网或编造）

# 工具调用纪律（直接影响你回答的快慢，必须遵守）
1. **互不依赖的调用要在同一次回复里一起发出**，不要拆成多轮来回。
   例：用户说「帮我安排一下周末」——recall_memory（了解他偏好什么）和 get_schedule（看已有安排）互不依赖，
   必须一次性同时调用；只有「先 recall_memory、再根据结果决定要不要 web_lookup」这类**真的有依赖**的才分轮。
2. **不要串行试探**。需要什么信息一次想全，能并行的一次给全，别一个一个试。
3. **已经给你的信息不要再查**。下面「关于这位用户」里列出的记忆，直接用来作答，
   **严禁为了确认它们再调一次 recall_memory**——那只会让用户多等一轮。
   （只有当你需要**列表之外**的更多记忆时，才调用 recall_memory。）

# 工作准则
1. 优先用工具获取或记录真实信息，再作答；不编造事实、数据、外部内容。
2. 回答简洁有温度，先给结论再给步骤；倾诉类先共情再给建议。
3. 涉及具体个人数据（账单/健康指标等）说明让用户在 App 内自行查看，不虚构。
4. 你拥有"全自动"主动性：轻量动作（记提醒、记录、给建议）直接做；仅在不可逆/高风险（发消息给他人、花钱、删除）前用 ask_user 向用户确认。
5. 遇到「规划行程 / 查攻略 / 查新闻·天气·政策·股价 / 了解外部实时信息 / 推荐去处·餐厅·玩法」类请求，必须先调用 web_lookup 取得真实资料，再据此组织具体回答——不要只凭记忆给笼统建议。需要记住用户偏好或为其设提醒时，同样优先调用 save_memory / set_reminder。
6. **接住上下文**：你能看到本会话之前的对话。用户说「设置一个提醒」「就按你说的办」「换个近一点的」这类**依赖上文**的话时，
   必须先读懂上文再行动，**绝对不要当成孤立的新问题**。
7. **缺信息时先推断，不要空泛反问**。不要问「提醒什么事？什么时候？」这种把球全踢回去的问题。
   正确做法：结合上文给出你的推断，让用户一句话确认或改。例如上文在聊假期安排、用户说「设置一个提醒」，
   你应该说：「帮你设个『今晚 22:30 早点睡』的提醒？要换成明早还是别的，你说一声我就改。」
   只有当推断确实无依据时，才给出**具体选项**让用户挑（如「设今晚 22:30 / 明早 9:00 / 你自己定个时间」）。
8. **「打开/查看/看一下《某产物》」是查看动作，不是创建动作**：**必须调用 open_artifact 读取真实内容后再展示**——
   严禁凭记忆或上文复述（会编造），也**严禁为此再去 create_artifact**。产物不存在时如实说没有，并列出当前有哪些产物。
9. **同一件事只做一次**。工具返回成功就是成功了，**严禁事后改口**说「刚才其实没生成」「是我表述太急」「这次是真的」——
   这类自我否定是幻觉，比做错更伤信任。用户重复同一句话时，换个角度回应（直接展示已有结果 / 问他想怎么改），不要原样复读。
10. 已存在的行程卡/提醒**不要重复创建**：同名产物会自动覆盖更新，相同提醒会自动去重，所以直接调用即可，不必先声明"我再重新生成一个"。
11. **主动记住用户（管家核心职责）**：当用户主动透露偏好（喜欢/讨厌/习惯/作息）、关键事实（城市/公司/生日/家人/职业）、计划或约定，或明确要求「记住/记着」时，**先调用 save_memory 把这件事存下，再据此回应**——你学到的事应该留到下一场对话也记得，而不是只存在于当前这一轮。recall_memory / get_schedule 需要时可随时调用，空库时返回「（暂无）」直接给方案即可，但不要为了「先看看」而无故去查。

# 输出纪律（必须遵守，违反即为糟糕回复）
0. 【最高优先级】**禁止向用户汇报后台状态**。以下句式一律不许出现：
   「我(先)看看你的待办/记录/偏好」「我这边只掌握到…」「你之前提到…」「根据你的记忆/待办」
   「你的待办清单是空的」「(暂时)没有查到你的信息」「你手头没有已排的事」……
   用户不需要知道你查了什么、查到几条、数据库里有什么。**查不到就直接给方案，一个字都不要提。**
   同理：除非用户明确提到自己已有安排，否则不要为了「先看看」而去调 get_schedule / recall_memory。
1. 一条回复里只问**一轮**澄清，问题不超过 3 个。**绝不把同一组问题在一条回复里问第二遍**，也不要复述自己刚说过的话。
2. 先基于现有信息给出一份可用的初步方案/判断，再问澄清——不要一上来只抛问题、把球全踢回给用户。
3. **绝对不要在回复里复述后台数据**。禁止出现「我看了下你的记录」「我这边只掌握到…」「你之前提到…」「根据你的记忆/待办」这类开场或列举。
   - 记忆只用于**暗中**调整语气与建议的贴合度，不作为开场白素材，也**不要报数量**（如"我只掌握到两条信息"）。
   - 只有在用户**明确问「我有什么待办」「你记得我什么」**时才可以列出来作答。
   - 数据库里若没有任何关于该用户的记录，或调用 get_schedule / recall_memory 查到空结果，就**直接进入正题给方案**——
     **不要向用户报告「清单是空的」「没有查到你的信息」**。
4. 不臆断节假日安排、政策、天气、价格等实时信息；当前环境没有联网能力就如实说明，让用户自行核对官方来源，别替他编。
5. 默认控制在 250 字以内，除非用户明确要长文、清单或逐日计划。

# 关于这位用户（已知记忆，仅供参考，不要复述"根据记忆"）
${memoryContext}
注意：以上记忆**只用于让回答更贴合用户**，不要据此推断用户没说过的事（如节假日安排、工作进度、deadline）。

# 你当前可用的能力（已按需要加载，不要调用清单之外的工具）
${capabilities.length ? capabilities.map((c) => `- ${c}`).join('\n') : '- （本次未加载任何工具，直接以对话方式回应）'}

注意：能力是分层供给的。以上为当前已启用的工具；若某能力（如联网检索）未列出，说明当前环境未配置对应凭证，请如实告知用户你暂时无法联网，不要假装已检索。`;
}

/** 高风险动作识别：涉及他人 / 资金 / 不可逆，必须先走人在环确认 */
const RISKY_ACTION = /(发(消息|微信|短信|邮件)|转(账|钱)|付款|下单|删除|帮我(买|订))/;

/** 给 Promise 套超时，超时返回兜底值（避免单个外部调用拖死整轮） */
function pTimeout<T>(p: Promise<T>, ms: number, fallback?: T): Promise<T> {
  return Promise.race([p, new Promise<T>((resolve) => setTimeout(() => resolve(fallback as T), ms))]);
}

/** 数据库写入兜底：单条数据写失败不能让整轮对话崩掉 */
function safeDb(_name: string, fn: () => void): void {
  try {
    fn();
  } catch {
    /* 写入失败不影响主流程 */
  }
}

/** 流式执行一次 Agent 对话轮，逐 token 产出 AgentEvent，最后产出 done 摘要 */
export async function* runMockAgentTurn(opts: AgentTurnOptions): AsyncGenerator<AgentEvent> {
  const { sessionId, message, customerName, intent } = opts;
  const owner = customerName || 'guest';
  const text = String(message || '').trim();
  const toolsUsed: string[] = [];
  const stamp = (s: string) => s;

  // 演示模式也写活动流遥测，让指挥舱「活动流」在 mock 下就有真实内容
  const recordRun = () => {
    try {
      db.addAgentRun({
        session_id: sessionId,
        prompt: text,
        intent,
        tools_used: Array.from(new Set(toolsUsed)).join(','),
        outcome: 'handled',
        model: 'mock',
      });
    } catch {
      /* 遥测失败不影响主流程 */
    }
  };

  const emitTool = function* (name: string, input: unknown) {
    toolsUsed.push(name);
    yield { type: 'tool' as const, name, input };
  };

  // 0) 高风险动作：人在环确认（发消息/转账/下单/删除等，涉及他人/资金/不可逆）
  if (RISKY_ACTION.test(text)) {
    const action = text.slice(0, 48);
    const question = `你想让我「${action}」吗？这一步涉及外部操作（联系他人 / 资金 / 不可逆），我需要先跟你确认一下，避免误操作。`;
    const options = ['确认，去办', '先不，取消'];
    // 结构化记录意图，确认后由出站层真实执行（打通「代理真会办事」）
    const channel = /微信/.test(text)
      ? 'wechat'
      : /短信/.test(text)
        ? 'sms'
        : /邮件|mail|email/i.test(text)
          ? 'email'
          : /朋友圈/.test(text)
            ? 'moments'
            : 'message';
    const actionJson = JSON.stringify({ kind: 'relay', text, channel, question });
    const pq = db.addPendingQuestion(sessionId, owner, question, options, actionJson);
    toolsUsed.push('ask_user');
    yield { type: 'text', content: '稍等，这件事我得先跟你确认一下 👇' };
    yield { type: 'ask_user', id: pq.id, question, options, action_json: pq.action_json };
    recordRun();
    yield {
      type: 'done',
      fullText: '稍等，这件事我得先跟你确认一下 👇',
      intent,
      toolsUsed: Array.from(new Set(toolsUsed)),
      fallback: false,
    };
    return;
  }

  // 1) 联网检索（注意：不要用裸「今天/今日」，避免与「今天好累」等情绪句误触）
  if (/(查一下|查查|搜索|搜一下|新闻|天气|股价|百科|最新|攻略|政策|怎么去|多少钱|价格|报价|2026|今年|怎么走|怎么做|怎么用)/.test(text)) {
    yield* emitTool('web_lookup', { query: text });
    let reply: string;
    try {
      const r = await pTimeout(webSearch(text, { limit: 5 }), 6000);
      if (r.error || !r.results.length) {
        reply = `我试着帮你联网查了「${text}」${r.error ? `，但遇到了点问题（${r.error}）。` : '，暂时没抓到结果。'}配置好检索源（如 BRAVE_API_KEY）后我就能真正联网啦，先记着你的需求？`;
      } else {
        const top = r.results
          .slice(0, 3)
          .map((x, i) => `${i + 1}. ${x.title}\n   ${x.snippet}`)
          .join('\n');
        reply = `帮你联网查了「${text}」（来源：${r.source}）：\n\n${top}\n\n需要我把其中某条存成待办提醒吗？`;
      }
    } catch {
      reply = '联网检索暂时没接通，我先记着你的需求，等检索源就绪再帮你查～';
    }
    yield { type: 'text', content: reply };
    recordRun();
    yield { type: 'done', fullText: reply, intent, toolsUsed: Array.from(new Set(toolsUsed)), fallback: false };
    return;
  }

  // 2) 记提醒 / 待办
  if (/(提醒|记一下|帮我设|设个提醒|别忘了|记得|待办|几点|日程|闹钟)/.test(text)) {
    const when =
      text.match(/(?:明[天早晚]|后[天天]|大后[天天]|今[天晚早]|周[一二三四五六日天]|下[周周]|周末|中午|上午|下午|晚上|清晨|傍晚)(?:\s*(?:上午|下午|晚上|中午|清晨|傍晚))?\s*(?:\d+[点:：]\d*|\d+点|\d+:\d+)?|\d+[点:：]\d*|\d+点|\d+:\d+/)?.[0] || '';
    let what = text
      .replace(/(请|帮我|麻烦|能不能|可以|记得|别忘了|记一下|提醒我|帮我设个提醒|设置?提醒|设个提醒|添加?待办|记个待办|定个)/g, '')
      .replace(when, '')
      .replace(/[，。、！？!?~～]/g, '')
      .trim();
    if (!what) what = text;
    safeDb('set_reminder', () => db.addReminder(owner, what, when || null));
    // 打通：若配置了出站通道，最佳努力把提醒同步到外部（失败静默）
    void syncReminder(what, when || null, owner);
    yield* emitTool('set_reminder', { what, when });
    const reply = stamp(
      `好嘞，我已经帮你记下了${when ? `（${when}）` : ''}：${what}。到点在「管家此刻」里会看到，需要我到点提醒你吗？`
    );
    yield { type: 'text', content: reply };
    recordRun();
    yield { type: 'done', fullText: reply, intent, toolsUsed: Array.from(new Set(toolsUsed)), fallback: false };
    return;
  }

  // 3) 记记忆（偏好 / 事实）
  if (/(记住|记着|我喜欢|我习惯|我的偏好|我的城市|我住在|家在|老家|生日|上班|工作|读书|上学|在.*公司)/.test(text)) {
    let kind = 'fact';
    let key = '关键信息';
    let value = text.replace(/(请|帮我|记得|记住|记着|把|这个|一下|我)/g, '').trim();
    if (/喜欢|习惯|偏好|爱|讨厌/.test(text)) {
      kind = 'preference';
      key = '偏好';
    } else if (/城市|住在|家在|老家|在.*(市|省)/.test(text)) {
      kind = 'fact';
      key = '城市';
      const m = text.match(/((?:北京|上海|广州|深圳|杭州|成都|武汉|南京|西安|重庆|天津|苏州|青岛|长沙|郑州|厦门|[一-龥]{2,8}(?:市|省)))/);
      if (m) value = m[1];
    } else if (/生日/.test(text)) {
      kind = 'fact';
      key = '生日';
    }
    safeDb('save_memory', () => db.saveMemory(owner, kind, key, value || text));
    yield* emitTool('save_memory', { kind, key, value: value || text });
    const reply = stamp(
      `记下了～以后我就知道你${key === '偏好' ? '喜欢' : key === '城市' ? `在${value || ''}` : '的' + key}这件事了。还有想让我记住的吗？`
    );
    yield { type: 'text', content: reply };
    recordRun();
    yield { type: 'done', fullText: reply, intent, toolsUsed: Array.from(new Set(toolsUsed)), fallback: false };
    return;
  }

  // 4) 心情陪伴
  if (/(心情|好累|好难过|难过|焦虑|压力大|开心|兴奋|沮丧|情绪低落|烦|丧|难受|不开心)/.test(text)) {
    const neg = /(累|难过|焦虑|压力大|沮丧|低落|烦|丧|不开心|难受|崩)/.test(text);
    const level = neg ? 2 : 4;
    safeDb('checkin_mood', () => db.addMood(owner, level, text.slice(0, 30)));
    yield* emitTool('checkin_mood', { level, note: text.slice(0, 30) });
    const reply = neg
      ? '听你这么说，感觉你最近确实挺不容易的。先别把自己逼太紧——要不要跟我说说具体发生了什么？或者我帮你把今天该做的事理一理，减轻点负担。'
      : '哇，听你这么说我也跟着开心起来了～这种好状态要留住，要不要记一笔今天值得开心的小事？';
    yield { type: 'text', content: reply };
    recordRun();
    yield { type: 'done', fullText: reply, intent, toolsUsed: Array.from(new Set(toolsUsed)), fallback: false };
    return;
  }

  // 5) 兜底闲聊：回看记忆以个性化
  const mems = db.getMemories(owner, 8);
  let reply: string;
  if (mems.length) {
    const m = mems[0];
    yield* emitTool('recall_memory', { query: '背景' });
    // 不把原始记忆整段粘进气泡：长内容只取短片段，避免一长段堆成「墙」
    const raw = String(m.value || '').replace(/\s+/g, ' ').trim();
    const valHead = raw.length > 20 ? '' : raw;
    const keyText = !m.key ? '一些事' : m.key.length > 16 ? m.key.slice(0, 16) + '…' : m.key;
    reply = valHead
      ? stamp(
          `我在呢～还记得你${m.kind === 'preference' ? '偏好' : '的'}${keyText}（比如「${valHead}」）。今天有什么想聊的，或者需要我帮你盯着的事吗？`
        )
      : stamp(`我在呢～还记得你之前提过「${keyText}」这类事。今天有什么想聊的，或者需要我帮你盯着的事吗？`);
  } else {
    reply = stamp(
      '我在呢～咱们刚认识，慢慢来。你可以让我帮你记提醒、查资料、或者就陪你随便聊聊。想先试试哪个？'
    );
  }
  yield { type: 'text', content: reply };
  recordRun();
  yield { type: 'done', fullText: reply, intent, toolsUsed: Array.from(new Set(toolsUsed)), fallback: false };
  void sessionId;
}
