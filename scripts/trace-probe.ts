/**
 * 回归探针：回放级 trace（P0·2026-10-25）
 *
 * 验证点：
 *   1) addAgentSpans + getRunTrace 往返：写入的 span 按 seq 有序、字段正确
 *   2) getAgentRunById：已知 id 命中、未知 id 返回 undefined
 *   3) getRunTrace：未知 runId 返回空数组（不报错）
 *   4) SpanCollector：flush(runId) 落库；flush('') 静默丢弃
 *   5) 端到端：驱动一次 Mock 对话轮，验证 run 行 + 有序 span 真实落库
 *
 * 红线自检：本探针只读/只写临时库，绝不把任何 span 回灌模型上下文。
 *
 * 运行：npx tsx scripts/trace-probe.ts   （已串入 `npm test`）
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmp = path.join(os.tmpdir(), `trace-probe-${Date.now()}.db`);
process.env.CHAT_DB_PATH = tmp;

// ⚠️ 必须在 import 数据层之前设 CHAT_DB_PATH（静态只 import 引擎，其余动态 import）
const db = await import('../server/db.js');
const { SpanCollector } = await import('../server/trace.js');
const { runMockAgentTurn } = await import('../server/agent.js');

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

const { v4: uuid } = await import('uuid');

try {
  console.log('\n[trace-probe] 1) addAgentSpans / getRunTrace 往返');
  const runId = uuid();
  db.addAgentRun({ id: runId, prompt: '测试轮', intent: 'other', model: 'probe' });
  const spans = [
    { phase: 'think' as const, text: '开始思考' },
    { phase: 'tool_call' as const, tool: 'recall_memory', args_json: '{"q":"x"}' },
    { phase: 'tool_result' as const, tool: 'recall_memory', result_json: '命中 2 条' },
    { phase: 'ask_user' as const, text: '需要你确认吗？' },
  ];
  db.addAgentSpans(runId, spans);
  const got = db.getRunTrace(runId);
  ok('span 数量一致', got.length === 4, `got ${got.length}`);
  ok('按 seq 有序', got.every((s, i) => s.seq === i + 1), JSON.stringify(got.map((s) => s.seq)));
  ok('phase 正确', got[0].phase === 'think' && got[1].phase === 'tool_call' && got[3].phase === 'ask_user');
  ok('tool 字段落地', got[1].tool === 'recall_memory');
  ok('args_json 落地', got[1].args_json === '{"q":"x"}');
  ok('result_json 落地', got[2].result_json === '命中 2 条');
  ok('run_id 关联正确', got.every((s) => s.run_id === runId));

  console.log('\n[trace-probe] 2) getAgentRunById');
  const byId = db.getAgentRunById(runId);
  ok('已知 id 命中', !!byId && byId.id === runId);
  ok('未知 id 返回 undefined', db.getAgentRunById('no-such-id') === undefined);

  console.log('\n[trace-probe] 3) getRunTrace 未知 runId');
  const empty = db.getRunTrace('no-such-run');
  ok('未知 runId 返回空数组', Array.isArray(empty) && empty.length === 0);

  console.log('\n[trace-probe] 4) SpanCollector flush 语义');
  const c1 = new SpanCollector();
  c1.think('采集器思考');
  c1.push({ phase: 'tool_call', tool: 'web_lookup', args_json: '{"q":"天气"}' });
  const c1Run = uuid();
  c1.flush(c1Run);
  const c1Got = db.getRunTrace(c1Run);
  ok('flush(runId) 落库', c1Got.length === 2, `got ${c1Got.length}`);
  ok('flush 后采集器清空', c1.size === 0);
  const c2 = new SpanCollector();
  c2.think('不应落库');
  c2.flush(''); // skipRecord 等价：空 runId
  ok('flush("") 静默丢弃（不落库）', db.getRunTrace('').length === 0);

  console.log('\n[trace-probe] 5) 端到端：驱动一次 Mock 对话轮');
  const sessionId = 'probe-session-' + Date.now();
  const owner = 'probe-owner';
  const events: string[] = [];
  for await (const ev of runMockAgentTurn({
    sessionId,
    message: '帮我设个提醒，周五下午交项目报告',
    intent: 'schedule',
    customerName: owner,
  })) {
    events.push(ev.type);
  }
  ok('产生了 done 事件', events.includes('done'));
  const runs = db.getAgentRuns(50).filter((r) => (r.tools_used || '').includes('set_reminder'));
  ok('落了一条带 set_reminder 的 run', runs.length >= 1, `runs=${runs.length}`);
  if (runs.length) {
    const trace = db.getRunTrace(runs[0].id);
    ok('该轮 trace 至少 1 个 span', trace.length >= 1, `spans=${trace.length}`);
    ok('trace 含 think（分支判定）', trace.some((s) => s.phase === 'think'));
    ok('trace 含 tool_call(set_reminder)', trace.some((s) => s.phase === 'tool_call' && s.tool === 'set_reminder'));
    ok('trace 按 seq 有序', trace.every((s, i) => s.seq === i + 1));
  }

  console.log(`\n[trace-probe] 结果：${pass} 通过 / ${fail} 失败`);
} catch (e: any) {
  console.error('[trace-probe] 运行异常：', e?.stack || e);
  fail++;
} finally {
  try {
    fs.rmSync(tmp);
    fs.rmSync(tmp + '-wal');
    fs.rmSync(tmp + '-shm');
  } catch {
    /* ignore */
  }
}

process.exit(fail ? 1 : 0);
