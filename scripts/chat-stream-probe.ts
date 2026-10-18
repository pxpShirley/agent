/**
 * 回归探针：从 send() 里抽出来的纯函数（B5 拆分单体）
 *
 * 这些逻辑以前埋在 408 行的闭包里，改一行要读完整段且完全测不到；
 * 抽成纯函数后可以逐条断言。任何一条回归都会在这里先炸出来。
 *
 * 运行：npx tsx scripts/chat-stream-probe.ts
 */
import {
  parseSseChunk,
  applyStepResult,
  settleSteps,
  decisionToStatus,
  intentLabelOf,
  artifactFromEvent,
  pendingFromEvent,
} from '../src/utils/chatStream.js';
import { buildMockPlan } from '../src/utils/localFallback.js';
import type { AgentStep } from '../src/types.js';

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

const frame = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;

console.log('\n[1] parseSseChunk 增量解析');
{
  // 一帧完整
  const r1 = parseSseChunk(frame({ type: 'text', content: '你好' }), '');
  ok('单帧解析出 1 个事件', r1.events.length === 1 && r1.events[0].content === '你好');
  ok('单帧后 buffer 清空', r1.buffer === '');
  // 一帧半：第二帧没拼完，必须留在 buffer 等下一片
  const half = frame({ type: 'text', content: 'a' }) + 'data: {"type":"te';
  const r2 = parseSseChunk(half, '');
  ok('半帧不产出事件', r2.events.length === 1, `实际 ${r2.events.length}`);
  ok('半帧残留留在 buffer', r2.buffer === 'data: {"type":"te', JSON.stringify(r2.buffer));
  // 续上
  const r3 = parseSseChunk('xt","content":"b"}\n\n', r2.buffer);
  ok('续上后半帧补齐', r3.events.length === 1 && r3.events[0].content === 'b', JSON.stringify(r3.events));
  ok('补齐后 buffer 清空', r3.buffer === '');
  // 一帧里带多行（如 event: / id:）
  const r4 = parseSseChunk('event: msg\ndata: {"type":"done"}\n\n', '');
  ok('多行帧能取到 data 行', r4.events.length === 1 && r4.events[0].type === 'done');
  // 坏帧不能打断整条流
  const r5 = parseSseChunk('data: {坏JSON\n\n' + frame({ type: 'notice', message: 'x' }), '');
  ok('坏帧被忽略且后续帧照常解析', r5.events.length === 1 && r5.events[0].message === 'x');
  // 无 data 行
  const r6 = parseSseChunk(': ping\n\n', '');
  ok('心跳注释行不产生事件', r6.events.length === 0);
}

console.log('\n[2] applyStepResult 工具结果归属');
{
  const mk = (id: string, name: string, status: AgentStep['status']): AgentStep => ({
    id, name, status, role: 'executor',
  });
  // 同名多次调用 → 先进先出
  let steps = [mk('1', 'web_lookup', 'running'), mk('2', 'web_lookup', 'running')];
  steps = applyStepResult(steps, 'web_lookup', true);
  ok('同名多次调用：先结算最早的那个', steps[0].status === 'done' && steps[1].status === 'running');
  steps = applyStepResult(steps, 'web_lookup', true);
  ok('第二次结算剩下的那个', steps[0].status === 'done' && steps[1].status === 'done');
  // 不同名 → 回退到最早一个 running
  steps = [mk('1', 'save_memory', 'running'), mk('2', 'web_lookup', 'running')];
  steps = applyStepResult(steps, 'web_lookup', true);
  ok('同名优先，不误伤别的工具', steps[0].status === 'running' && steps[1].status === 'done');
  // 全 done 时不动
  steps = [mk('1', 'x', 'done')];
  ok('没有 running 时原样返回', applyStepResult(steps, 'x', true) === steps);
  // 失败标记
  steps = [mk('1', 'x', 'running')];
  ok('ok=false 会标记 error', applyStepResult(steps, 'x', false)[0].error === true);
}

console.log('\n[3] settleSteps 收尾');
{
  const steps: AgentStep[] = [
    { id: '1', name: 'a', status: 'running', role: 'planner' },
    { id: '2', name: 'b', status: 'done', role: 'planner' },
  ];
  const out = settleSteps(steps);
  ok('running 全部收尾', out.every((s) => s.status === 'done'));
  ok('已完成的保持原样', out[1].status === 'done' && out[1].error === undefined);
  ok('默认不标 error', out[0].error === false);
  ok('markError 时标 error', settleSteps(steps, true)[0].error === true);
  ok('原数组不被就地修改', steps[0].status === 'running');
}

console.log('\n[4] decisionToStatus / intentLabelOf');
ok('approve → confirmed', decisionToStatus('approve') === 'confirmed');
ok('escalate → escalated', decisionToStatus('escalate') === 'escalated');
ok('defer → deferred', decisionToStatus('defer') === 'deferred');
ok('cancel → cancelled', decisionToStatus('cancel') === 'cancelled');
ok('未知意图码回退「其他」', intentLabelOf('不存在的意图' as any) === '其他');

console.log('\n[5] 事件 → 前端对象');
{
  const art = artifactFromEvent({ type: 'artifact', id: 'A1', title: '杭州行程', artifactType: 'itinerary' }, 'S1');
  ok('产物带 session_id', art.session_id === 'S1');
  ok('产物类型有默认值', artifactFromEvent({ type: 'artifact', id: 'A2' }, null).type === 'note');
  ok('产物标题有默认值', artifactFromEvent({ type: 'artifact', id: 'A2' }, null).title === '未命名产物');
  const pq = pendingFromEvent(
    { type: 'ask_user', id: 'P1', question: '要发吗？', options: '发,不发', action_json: '{"kind":"relay"}' },
    'S1'
  );
  ok('待确认卡初始 pending', pq.status === 'pending');
  ok('待确认卡带 sessionId', pq.sessionId === 'S1');
  ok('待确认卡把逗号串归一成数组', JSON.stringify(pq.options) === JSON.stringify(['发', '不发']), JSON.stringify(pq.options));
  ok('待确认卡带 action_json', pq.actionJson === '{"kind":"relay"}');
  ok(
    '已是数组时原样保留',
    JSON.stringify(
      pendingFromEvent({ type: 'ask_user', id: 'P2', question: 'q', options: ['确认', '改一下'] }, 'S1').options
    ) === JSON.stringify(['确认', '改一下'])
  );
  ok('没给 options 时为 null', pendingFromEvent({ type: 'ask_user', id: 'P3', question: 'q' }, 'S1').options === null);
}

console.log('\n[6] buildMockPlan 意图识别（纯函数）');
{
  const now = new Date(2026, 9, 6, 15, 0, 0);
  const p1 = buildMockPlan('帮我规划杭州周末游', now);
  ok('行程类 → 行程规划', p1.intentLabel === '行程规划', p1.intentLabel);
  ok('行程类带产物', p1.artifact?.type === 'itinerary');
  ok('行程类记忆记 plan', p1.memKind === 'plan');

  const p2 = buildMockPlan('明天下午三点提醒我开会', now);
  ok('提醒类 → 提醒备忘', p2.intentLabel === '提醒备忘', p2.intentLabel);
  ok('提醒类会写待办', p2.makeReminder === true);
  ok('提醒类记忆记 reminder', p2.memKind === 'reminder');

  const p3 = buildMockPlan('今天心情有点累', now);
  ok('情绪类 → 心情关怀', p3.intentLabel === '心情关怀', p3.intentLabel);
  ok('情绪类记忆记 mood', p3.memKind === 'mood');
  ok('情绪类不产生产物', p3.artifact === null);

  const p4 = buildMockPlan('帮我写一份周报', now);
  ok('报告类 → 报告整理', p4.intentLabel === '报告整理', p4.intentLabel);
  ok('报告类产物是 report', p4.artifact?.type === 'report');

  const p5 = buildMockPlan('随便聊聊', now);
  ok('兜底 → 日常陪伴', p5.intentLabel === '日常陪伴', p5.intentLabel);
  ok('兜底不写待办', p5.makeReminder === false);

  const p6 = buildMockPlan('这个怎么买最划算', now);
  ok('省钱类 → 省钱参谋', p6.intentLabel === '省钱参谋', p6.intentLabel);
  ok('省钱类产物是 checklist', p6.artifact?.type === 'checklist');

  ok('同一输入两次结果一致（纯函数）', JSON.stringify(buildMockPlan('帮我规划杭州周末游', now).reply) === JSON.stringify(p1.reply));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
