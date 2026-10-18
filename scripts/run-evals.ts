/**
 * Evals 运行器 —— 用真实引擎跑用例，用可复现规则判定。
 *
 * 为什么单独一个脚本、不并入 `npm test`：
 *   test 跑的是纯函数与静态断言（毫秒级、零成本、可每次提交都跑）；
 *   eval 要真的调模型（几秒到几十秒、有 token 成本）。混在一起的结果是
 *   大家为了省时间把 test 也关掉。所以两者分开，各自全绿才算过关。
 *
 * 两个容易踩的坑（都在这里处理了）：
 *   1. `CHAT_DB_PATH` 必须在 **import 数据层之前** 设好——db/core.ts 在模块初始化时就读它。
 *      所以这里静态 import 只放 `server/env.js`（加载 .env 的副作用，不依赖数据库路径），
 *      数据层与引擎一律动态 import。
 *   2. 消息落库是路由的职责，不是引擎的（bailian.ts 只读历史不写历史）。
 *      所以多轮用例必须由运行器自己把 user / assistant 消息写进去，
 *      否则 `buildHistory` 读不到上一轮，多轮指代那条就成了单轮空转。
 *
 * 运行：npm run eval          跑全部
 *      npm run eval -- <关键字>   只跑 id 含关键字的用例
 */
import '../server/env.js';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { CASES, SELF_DENIAL, type EvalCase } from '../evals/cases.js';

const tmpDb = path.join(os.tmpdir(), `xinglan-eval-${Date.now()}.db`);
process.env.CHAT_DB_PATH = tmpDb;

const db = await import('../server/db.js');
const { runBailianAgentTurn } = await import('../server/llm/bailian.js');
const { classifyIntent } = await import('../server/nlu.js');
const { isCompatEngineConfigured } = await import('../server/settings.js');

const filter = process.argv[2]?.trim();
const cases = filter ? CASES.filter((c) => c.id.includes(filter)) : CASES;

if (!isCompatEngineConfigured()) {
  console.log('\n⚠️ 未配置真实引擎（DEEPSEEK_API_KEY / 百炼均未配置），evals 未执行。');
  console.log('   evals 必须打真实模型，mock 引擎跑出来的"通过"没有意义。\n');
  process.exit(2);
}
if (!cases.length) {
  console.log(`\n⚠️ 没有匹配「${filter}」的用例。可用 id：${CASES.map((c) => c.id).join(', ')}\n`);
  process.exit(2);
}

/** 单条用例总时限：引擎卡住不该让整轮 eval 挂死 */
const CASE_TIMEOUT_MS = 90_000;

function withDeadline<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let t: NodeJS.Timeout;
  return Promise.race([
    p,
    new Promise<never>((_, rej) => {
      t = setTimeout(() => rej(new Error(`${label} 超时 ${ms / 1000}s`)), ms);
    }),
  ]).finally(() => clearTimeout(t)) as Promise<T>;
}

/** 纯规则判定：返回所有不满足的原因（空数组 = 通过） */
function judge(c: EvalCase, text: string, tools: string[]): string[] {
  const e = c.expect;
  const why: string[] = [];
  for (const s of e.mustInclude ?? []) if (!text.includes(s)) why.push(`缺少「${s}」`);
  if (e.mustIncludeAny?.length && !e.mustIncludeAny.some((s) => text.includes(s)))
    why.push(`缺少任一：${e.mustIncludeAny.join(' / ')}`);
  if (e.mustMatchAny?.length && !e.mustMatchAny.some((r) => r.test(text)))
    why.push(`未匹配任一正则：${e.mustMatchAny.map((r) => `/${r.source}/`).join(' ')}`);
  for (const s of e.mustNotInclude ?? []) if (text.includes(s)) why.push(`不该出现「${s}」`);
  for (const t of e.toolCalled ?? []) if (!tools.includes(t)) why.push(`未调用工具 ${t}`);
  if (e.toolCalledAny?.length && !e.toolCalledAny.some((t) => tools.includes(t)))
    why.push(`未调用任一工具：${e.toolCalledAny.join(' / ')}`);
  for (const t of e.toolNotCalled ?? []) if (tools.includes(t)) why.push(`不该调用 ${t}`);
  if (e.noSelfDenial) for (const s of SELF_DENIAL) if (text.includes(s)) why.push(`自我否定话术「${s}」`);
  return why;
}

interface CaseResult {
  why: string[];
  text: string;
  tools: string[];
  choices: string[];
}

async function runCase(c: EvalCase): Promise<CaseResult> {
  const owner = `eval-${c.id}`;
  const sessionId = randomUUID();
  db.createSession({ id: sessionId, title: c.name, model: 'eval', customer_name: owner });
  c.seed?.({ db, owner, sessionId });

  let text = '';
  let tools: string[] = [];
  /** 「空泛反问」护栏生成的选项（最后一轮纯文本被判为空泛反问时产出） */
  let choices: string[] = [];
  /** 引擎是否回退到本地兜底。回退出来的"通过"是假的：测的是 mock，不是模型。 */
  let fellBack = false;
  let engineError = '';

  for (const turn of c.turns) {
    db.createMessage({ id: randomUUID(), session_id: sessionId, role: 'user', content: turn });
    const intent = c.intent ?? classifyIntent(turn).intent;
    let turnText = '';
    const turnTools: string[] = [];
    let turnChoices: string[] = [];
    for await (const ev of runBailianAgentTurn({ sessionId, message: turn, customerName: owner, intent })) {
      if (ev.type === 'text') turnText += ev.content || '';
      else if (ev.type === 'tool') turnTools.push(ev.name);
      else if (ev.type === 'done') {
        if (ev.fullText) turnText = ev.fullText;
        if (ev.toolsUsed?.length) tools = ev.toolsUsed.slice();
        if (ev.choices?.length) turnChoices = ev.choices;
        if (ev.fallback) fellBack = true;
        if (ev.error) engineError = ev.error;
      }
    }
    // 合并本轮工具：done.toolsUsed 更全，但流式 tool 事件更及时，两者取并集
    tools = Array.from(new Set([...tools, ...turnTools]));
    choices = turnChoices;
    text = turnText;
    // 写回历史：下一轮的 buildHistory 依赖它
    db.createMessage({ id: randomUUID(), session_id: sessionId, role: 'assistant', content: turnText });
  }

  // ⚠️ 兜底必须判失败。否则网络一抖，本地 mock 的输出会被当成模型表现，
  //    eval 从"尺子"变成"安慰剂"——而且是最难发现的那种假绿。
  if (fellBack) {
    return { why: [`引擎回退到本地兜底（${engineError || '未给出原因'}），此用例不算通过`], text, tools, choices };
  }
  return { why: judge(c, text, tools), text, tools, choices };
}

console.log(`\n星澜 Evals · ${cases.length} 条用例 · 真实引擎\n`);

let failed = 0;
const t0 = Date.now();
for (const c of cases) {
  const started = Date.now();
  let r: CaseResult = { why: [], text: '', tools: [], choices: [] };
  try {
    r = await withDeadline(runCase(c), CASE_TIMEOUT_MS, c.id);
  } catch (err) {
    r = { why: [`运行异常：${(err as Error).message}`], text: '', tools: [], choices: [] };
  }
  const dur = ((Date.now() - started) / 1000).toFixed(1);
  if (r.why.length) {
    failed++;
    console.log(`  ✗ ${c.id}（${dur}s）`);
    r.why.forEach((w) => console.log(`      - ${w}`));
    // 失败时打印原文：不看到模型到底说了什么，就无法判断是断言不合理还是模型真没做对
    console.log(`      工具：[${r.tools.join(', ') || '无'}]`);
    console.log(`      护栏选项：[${r.choices.join(' | ') || '无'}]`);
    console.log(`      原文：${r.text.replace(/\s+/g, ' ').slice(0, 260) || '（空）'}`);
  } else {
    console.log(`  ✓ ${c.id}（${dur}s）`);
  }
}

try { fs.unlinkSync(tmpDb); } catch { /* 临时库，删不掉也无所谓 */ }

const total = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n${cases.length - failed} 通过 / ${failed} 失败 · 用时 ${total}s\n`);
process.exit(failed ? 1 : 0);
