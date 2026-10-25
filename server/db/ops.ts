import { v4 as uuidv4 } from 'uuid';
import { db, now } from './core.js';
import type { MemoryRecord } from './memories.js';
import type { ReminderRecord } from './reminders.js';
import type { MoodRecord } from './moods.js';


/** 运营侧：跨用户全量记忆（治理用） */
export function listAllMemories(limit = 200): MemoryRecord[] {
  return db.prepare('SELECT * FROM memories ORDER BY updated_at DESC LIMIT ?').all(limit) as MemoryRecord[];
}

/** 运营侧：跨用户全量待办（治理用） */
export function listAllReminders(includeDone = true): ReminderRecord[] {
  const sql = includeDone
    ? 'SELECT * FROM reminders ORDER BY done ASC, created_at DESC'
    : 'SELECT * FROM reminders WHERE done = 0 ORDER BY created_at DESC';
  return db.prepare(sql).all() as ReminderRecord[];
}

/** 运营侧：跨用户全量心情（治理用） */
export function listAllMoods(limit = 200): MoodRecord[] {
  return db.prepare('SELECT * FROM moods ORDER BY created_at DESC LIMIT ?').all(limit) as MoodRecord[];
}

export interface AgentRunRecord {
  id: string;
  session_id: string | null;
  prompt: string | null;
  intent: string | null;
  tools_used: string | null;
  outcome: string | null;
  model: string | null;
  /** L0+ ② 主循环 span：本轮 ReAct 迭代次数 */
  iterations: number | null;
  /** 本轮工具调用总次数 */
  tool_calls_count: number | null;
  /** 其中走了并发分支（Promise.all 只读工具）的轮次数 */
  parallel_rounds: number | null;
  /** 整轮耗时（ms） */
  latency_ms: number | null;
  created_at: string;
}

export function addAgentRun(run: Partial<AgentRunRecord> & { id?: string }): AgentRunRecord {
  const row: AgentRunRecord = {
    id: run.id || uuidv4(),
    session_id: run.session_id ?? null,
    prompt: run.prompt ?? null,
    intent: run.intent ?? null,
    tools_used: run.tools_used ?? null,
    outcome: run.outcome ?? null,
    model: run.model ?? null,
    iterations: run.iterations ?? null,
    tool_calls_count: run.tool_calls_count ?? null,
    parallel_rounds: run.parallel_rounds ?? null,
    latency_ms: run.latency_ms ?? null,
    created_at: now(),
  };
  db.prepare(
    `INSERT INTO agent_runs (id,session_id,prompt,intent,tools_used,outcome,model,iterations,tool_calls_count,parallel_rounds,latency_ms,created_at)
     VALUES (@id,@session_id,@prompt,@intent,@tools_used,@outcome,@model,@iterations,@tool_calls_count,@parallel_rounds,@latency_ms,@created_at)`
  ).run(row);
  return row;
}

/** L0+ ② 主循环观测：最近 N 轮的迭代/工具/并发/耗时均值，用来验证优化是否真的省了轮次 */
export function getLoopStats(limit = 100): {
  runs: number;
  /** 其中带 span 埋点的轮数（旧记录为 null，不参与均值，避免把均值拉成 0） */
  spanRuns: number;
  avgIterations: number;
  avgToolCalls: number;
  avgLatencyMs: number;
  parallelRuns: number;
  multiStepRuns: number;
  topTools: Array<{ name: string; n: number }>;
} {
  const rows = db
    .prepare('SELECT * FROM agent_runs ORDER BY created_at DESC LIMIT ?')
    .all(limit) as AgentRunRecord[];
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const withSpan = rows.filter((r) => r.iterations !== null);
  const avg = (pick: (r: AgentRunRecord) => number | null) =>
    withSpan.length ? withSpan.reduce((s, r) => s + num(pick(r)), 0) / withSpan.length : 0;
  const toolCount = new Map<string, number>();
  for (const r of rows) {
    for (const t of String(r.tools_used || '').split(',')) {
      const n = t.trim();
      if (n) toolCount.set(n, (toolCount.get(n) || 0) + 1);
    }
  }
  return {
    runs: rows.length,
    spanRuns: withSpan.length,
    avgIterations: Math.round(avg((r) => r.iterations) * 100) / 100,
    avgToolCalls: Math.round(avg((r) => r.tool_calls_count) * 100) / 100,
    avgLatencyMs: Math.round(avg((r) => r.latency_ms)),
    parallelRuns: withSpan.filter((r) => num(r.parallel_rounds) > 0).length,
    multiStepRuns: withSpan.filter((r) => num(r.iterations) > 1).length,
    topTools: Array.from(toolCount.entries())
      .map(([name, n]) => ({ name, n }))
      .sort((a, b) => b.n - a.n)
      .slice(0, 8),
  };
}

/** 指挥舱·活动流：最近的 agent 自主动作遥测（倒序） */
export function getAgentRuns(limit = 50): AgentRunRecord[] {
  return db.prepare('SELECT * FROM agent_runs ORDER BY created_at DESC LIMIT ?').all(limit) as AgentRunRecord[];
}

// ============================================================
// 回放级 trace（P0·2026-10-25）
// 把一次对话轮拆成有序 span 落库，支持只读回放与 trace 视图。
// ⚠️ 红线：span 仅入库供观测，任何情况不得回灌模型上下文。
// ============================================================
export type SpanPhase = 'think' | 'tool_call' | 'tool_result' | 'ask_user' | 'error' | 'intent';

/** 单个 span 的写入模型（seq 由 addAgentSpans 落库时按 push 顺序自动编号） */
export interface SpanInput {
  phase: SpanPhase;
  /** tool_call / tool_result 阶段的工具名 */
  tool?: string | null;
  /** tool_call 入参摘要（JSON 文本，已截断） */
  args_json?: string | null;
  /** tool_result 返回摘要（文本，已截断） */
  result_json?: string | null;
  /** think / ask_user / error / intent 的可见文本（已截断） */
  text?: string | null;
  tokens?: number | null;
  ms?: number | null;
}

/** 落库后的完整 span 记录（含 run_id / seq / created_at） */
export interface AgentSpanRecord extends SpanInput {
  id: string;
  run_id: string;
  seq: number;
  created_at: string;
}

/** 批量落库一次 run 的全部 span，seq 按入参顺序从 1 递增；空 runId 或空数组为空操作 */
export function addAgentSpans(runId: string, spans: SpanInput[]): void {
  if (!runId || !spans.length) return;
  const insert = db.prepare(
    `INSERT INTO agent_spans (id,run_id,seq,phase,tool,args_json,result_json,text,tokens,ms,created_at)
     VALUES (@id,@run_id,@seq,@phase,@tool,@args_json,@result_json,@text,@tokens,@ms,@created_at)`
  );
  const tx = db.transaction(() => {
    let seq = 1;
    for (const s of spans) {
      insert.run({
        id: uuidv4(),
        run_id: runId,
        seq,
        phase: s.phase,
        tool: s.tool ?? null,
        args_json: s.args_json ?? null,
        result_json: s.result_json ?? null,
        text: s.text ?? null,
        tokens: s.tokens ?? null,
        ms: s.ms ?? null,
        created_at: now(),
      });
      seq++;
    }
  });
  tx();
}

/** 按发生顺序取回一次 run 的全部 span（回放用），不存在返回空数组 */
export function getRunTrace(runId: string): AgentSpanRecord[] {
  return db
    .prepare('SELECT * FROM agent_spans WHERE run_id = ? ORDER BY seq ASC')
    .all(runId) as AgentSpanRecord[];
}

/** 按主键取回一次 run 的元信息（trace 视图要同时展示 run + spans） */
export function getAgentRunById(id: string): AgentRunRecord | undefined {
  return db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(id) as AgentRunRecord | undefined;
}

/** 指挥舱·例外收件箱：尚未处理（pending）的待确认高风险动作 */
export function getOpenPending(owner?: string): ClientPending[] {
  const base = 'SELECT * FROM pending_questions WHERE status = ?';
  const rows = owner
    ? (db.prepare(`${base} AND owner = ? ORDER BY created_at DESC`).all('pending', owner) as Array<
        PendingQuestion & { options: string | null }
      >)
    : (db.prepare(`${base} ORDER BY created_at DESC`).all('pending') as Array<PendingQuestion & { options: string | null }>);
  return rows.map((r) => toClientPending({ ...r, options: r.options ? JSON.parse(r.options) : null }));
}

export function addOverride(sessionId: string | null, reason: string, action: string): void {
  db.prepare(`INSERT INTO overrides (id,session_id,reason,action,created_at) VALUES (?,?,?,?,?)`).run(
    uuidv4(),
    sessionId,
    reason,
    action,
    now()
  );
}

// ============================================================
// 人在环：待确认的高风险动作（ask_user 闭环）
// ============================================================
export interface PendingQuestion {
  id: string;
  session_id: string;
  owner: string;
  question: string;
  options: string[] | null;
  status: 'pending' | 'confirmed' | 'cancelled' | 'escalated' | 'deferred';
  answer: string | null;
  created_at: string;
  answered_at: string | null;
  /** 待确认动作的结构化描述（JSON 字符串）：高风险动作确认后由出站层真实执行 */
  action_json: string | null;
}

/** 返回给前端的待确认项（camelCase，与 src/types.ts PendingQuestion 对齐，含可编辑草稿 actionJson） */
export interface ClientPending {
  id: string;
  sessionId: string;
  owner: string;
  question: string;
  options: string[] | null;
  status: 'pending' | 'confirmed' | 'cancelled' | 'escalated' | 'deferred';
  answer: string | null;
  createdAt: string;
  answeredAt?: string | null;
  actionJson?: string | null;
}

export function toClientPending(pq: PendingQuestion): ClientPending {
  return {
    id: pq.id,
    sessionId: pq.session_id,
    owner: pq.owner,
    question: pq.question,
    options: pq.options,
    status: pq.status,
    answer: pq.answer,
    createdAt: pq.created_at,
    answeredAt: pq.answered_at ?? null,
    actionJson: pq.action_json ?? null,
  };
}

export function addPendingQuestion(
  sessionId: string,
  owner: string,
  question: string,
  options?: string[] | null,
  actionJson?: string | null
): PendingQuestion {
  const row: PendingQuestion = {
    id: uuidv4(),
    session_id: sessionId,
    owner: owner || 'guest',
    question,
    options: options && options.length ? options : null,
    status: 'pending',
    answer: null,
    created_at: now(),
    answered_at: null,
    action_json: actionJson && actionJson.trim() ? actionJson : null,
  };
  db.prepare(
    `INSERT INTO pending_questions (id,session_id,owner,question,options,status,answer,created_at,answered_at,action_json)
     VALUES (@id,@session_id,@owner,@question,@options,@status,@answer,@created_at,@answered_at,@action_json)`
  ).run({
    ...row,
    options: row.options ? JSON.stringify(row.options) : null,
  });
  return row;
}

export function getPendingQuestion(id: string): PendingQuestion | undefined {
  const row = db.prepare('SELECT * FROM pending_questions WHERE id = ?').get(id) as
    | (PendingQuestion & { options: string | null; action_json: string | null })
    | undefined;
  if (!row) return undefined;
  return {
    ...row,
    options: row.options ? JSON.parse(row.options) : null,
    action_json: row.action_json ?? null,
  };
}

/** 更新待确认项的结构化动作（用于「改后批准」回写编辑后的草稿） */
export function updatePendingAction(id: string, actionJson: string): void {
  db.prepare(`UPDATE pending_questions SET action_json = ? WHERE id = ?`).run(actionJson, id);
}

/**
 * 给待确认项一个答复（人在环闭环）：落状态 / 答复 / 答复时间，返回更新后的记录。
 * 记录不存在（已被清理）时返回 undefined，调用方据此判断。
 */
export function answerPendingQuestion(
  id: string,
  status: PendingQuestion['status'],
  answer: string | null = null
): PendingQuestion | undefined {
  const cur = getPendingQuestion(id);
  if (!cur) return undefined;
  const answeredAt = now();
  db.prepare(`UPDATE pending_questions SET status = ?, answer = ?, answered_at = ? WHERE id = ?`).run(
    status,
    answer,
    answeredAt,
    id
  );
  return { ...cur, status, answer, answered_at: answeredAt };
}

/** 所有有数据的 owner（记忆/待办/心情/会话），供 scheduler 遍历 */
export function distinctOwners(): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT owner FROM (
         SELECT owner FROM memories
         UNION SELECT owner FROM reminders
         UNION SELECT owner FROM moods
         UNION SELECT customer_name AS owner FROM sessions WHERE customer_name IS NOT NULL AND customer_name != ''
       )`
    )
    .all() as { owner: string }[];
  return rows.map((r) => r.owner).filter(Boolean);
}
