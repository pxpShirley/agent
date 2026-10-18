# ARCHITECTURE v3.1 增补：修订补丁 · 接口契约 · 开工清单

> 配套：`docs/architecture-v3.1.html`
> 关系：本文件**不改写** `docs/ARCHITECTURE-v3.md`，只给出「按位置替换 / 新增」的补丁与新增接口契约。
> 定稿后建议把 A~F 并入 `ARCHITECTURE-v3.md` 并升版为 v3.1，然后**只保留一份**真相源。
> 核对快照：2026-10-07 工作区；所有行号均已逐条复核。

---

## 0. 摘要（给决策者）

- **方向、分层、排序成立**，v3 的 5 条设计原则、四层记忆划分、P0→P3 顺序都保留。
- 但作为**施工指导书**尚有 8 处需要修：事实基线 3 处陈旧、接口 2 处矛盾、优先级 1 处错配、P0 缺 2 项前置（版本控制、token 采集）。
- 修正后的顺序：**P0-0 `git init` → P0 观测与 evals → P1 上下文引擎 → P2 摘要 → P3 Skills**；**并行工具从"最高优先"降为 P2**，并补前置条件。

---

## A. 对 `ARCHITECTURE-v3.md` 的逐条修订

| # | 位置 | 原文（摘要） | 改为 | 依据 |
|---|---|---|---|---|
| A1 | §1 现状诊断"做对的" | "6s 客户端看门狗" | "150s 前端看门狗（`ENGINE_WATCHDOG_MS`）；另有 route 120s、循环 abort 180s、工具 15s×3" | `src/hooks/useServiceChat.ts:33`、`server/routes/chat.ts:17`、`server/llm/bailian.ts:354`、`server/tools/registry.ts:507` |
| A2 | §1 短板 3 | "可观测有表无视图" | "有**轮级**视图（治理面板活动流消费 `agent_runs`），缺**步级** trace" | `src/components/GovernanceLayer.tsx:215-224`、`server/routes/admin.ts:137` |
| A3 | §1.5 表"已做对" | "迭代上限 6 轮 / `bailian.ts` `MAX_AGENT_ITERATIONS=6`" | 位置改为 `server/agent.ts:22`（`bailian.ts:18` 为 import） | `server/agent.ts:22` |
| A4 | §1.5 表"已做对" | "180s 总超时 / `AbortController`" | 保留事实，但补注"4 层超时彼此不协调，需收敛为单一延迟预算"；`180s` 只负责掐断底层 fetch，用户侧先被 120s 判定失败 | 同上 A1 |
| A5 | §1.5 补强 1（并行工具） | "最高优先" | 降为 **P2**；补前置条件：`Tool` 增 `sideEffect` 元数据、`messages` 必须按 `tool_call_id` 回填；说明"每轮一次 LLM 流式调用不可并行、SQLite 为同步驱动，受益面仅网络型工具" | `server/llm/bailian.ts:394-450,430`、`server/tools/registry.ts:491-514` |
| A6 | §1.5 补强 列表 | （缺） | 追加"两处随 L1 一起修"：① `fullText` 跨轮累积后逐轮回写为 assistant `content`，重复注入上下文；② 工具返回值无长度上限（`MEMORY_SNIPPET_MAX` 仅作用于记忆） | `server/llm/bailian.ts:386`、`server/llm/bailian.ts:430` |
| A7 | §3.1 预算器 | "禁止魔法数字" | 追加**前置条件**："P0 必须先采到真实 `usage`，否则系数即魔法数字" | `server/db/core.ts:92-101`（无 token 列）、`server/llm/bailian.ts:109-182`（未解析 usage） |
| A8 | §3.3 / §3.4 路径 | `server/memory/retrieval.ts`（§3.3）与 `server/context/retrieval.ts`（§3.4、HTML）不一致 | 二选一，**建议统一为 `server/context/retrieval.ts`**（消费方只有装配器） | 文档内部冲突 |
| A9 | §3.4 装配器 | `assembleContext(): AssembledContext`（同步） | 拆成 `assembleContext()`（turn 级·同步·唯一出口）与 `guardBudget()`（iteration 级）；明确"摘要异步 → 装配只读已生成摘要 + `compacted` 标志" | 见 B1 |
| A10 | §3.4 迁移步骤 | "用 `assembleContext()` 替换 `buildHistory()` + `buildMemoryContext()`" | 追加第 0 步：**收口产物注入旁路** `tryFindArtifactContent()`（当前把产物全文直接拼进 user 消息），否则"唯一出口"不成立 | `server/llm/bailian.ts:295-306,358` |
| A11 | §4.2 写记忆纪律 | "复用 `normKey`" | 改为"**服务端新增** `normalizeMemoryKey()`"：`normKey` 只存在于前端；服务端 `saveMemory()` 是精确 key 覆盖，"同义不同 key"仍会重复 | `src/components/dashboard/shared.ts:50`、`server/db/memories.ts:24-26` |
| A12 | §5 标题 / §6 标题 | "## 5. L3 · Evals 与 Trace" / "## 6. L4 · Skills" | 改为 **§5 = L4 · Evals & Trace**、**§6 = L3 · Skills**（与 §2 分层图、与 HTML 一致） | v3 内部冲突 |
| A13 | §5.1 Trace | `agent_spans` DDL 无 token 列 | 追加 `tokens` 字段；追加写入策略：脱敏、保留期、批量异步写 | 见 C |
| A14 | §5.1 Trace | "治理面板新增「本轮 trace」视图" | 保留；补注"面板已有**轮级**活动流，本次新增的是**步级**展开"，并新增"`outcome` 真实化"为前置 | 见 A2、`server/llm/bailian.ts:346`、`server/agent.ts:169` |
| A15 | §5.2 Evals | 4 条用例 | 用例**按层分组**并扩到 7 条（E1–E7）；新增断言类型 `maxTokens` / `eventSeen` / `outcomeIs`；规定**缺 Key 时输出 SKIPPED，不得假绿** | 见 D |
| A16 | §7 落地顺序表 | 只有阶段与"做什么" | 每阶段补"**完成判据**"（至少 P0/P1）；P0 增 3 项：`git init` + 基线提交、usage/tokens 采集、`outcome` 真实化 | 见 E |
| A17 | §9 风险与对策 | 5 条 | 追加 3 条：trace 数据面无治理 / 无 VCS·CI 时"全绿"不可信 / 并行改造致 `tool_call_id` 错配 | 见 F |

---

## B. 新增接口契约

### B1 `server/context/assemble.ts` —— 拆成两个 API

```ts
/** turn 级：主循环获取上下文的唯一出口。**同步**（不得 await 摘要生成）。 */
export interface AssembledContext {
  system: string;
  memory: string;
  tools: unknown[];
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** 本次注入的「当前用户消息」（含产物真实内容等旁路注入，统一在此拼装） */
  current: string;
  budget: TokenBudget;
  stats: {
    historyChars: number;
    memoryCount: number;
    /** 是否已使用滚动摘要；false 表示摘要未就绪、本轮用原文顶着 */
    compacted: boolean;
    /** 摘要版本号，便于 trace 里核对"""
    summaryVersion: number;
    /** 被旁路注入的产物 id（可观测，避免"黑箱注入"） */
    injectedArtifactIds: string[];
  };
}

export function assembleContext(opts: {
  owner: string;
  sessionId: string;
  current: string;
  toolDefs: unknown[];
  model: string;
}): AssembledContext;

/** iteration 级：轮内预算守卫。可裁剪最旧 tool 结果，但不得动 system 与近 K 轮。 */
export function guardBudget(
  messages: Array<Record<string, unknown>>,
  budget: TokenBudget
): { messages: Array<Record<string, unknown>>; truncated: number; overBudget: boolean };
```

**约定（必须写进代码注释）**
1. `assembleContext()` 同步：只读**已生成**的摘要；缺失或过期时用原文 + `compacted:false`，并 `void compactOldTurns(...)` 后台补做（fire-and-forget，不阻塞本轮）。
2. 摘要生成失败**不回滚**本轮：视为 `compacted:false`，且必须写入 trace（降级可观测，不静默）。
3. `guardBudget()` 在每轮 `streamCompat()` **之前**调用；裁剪顺序：最旧 tool 结果 → 最旧工具调用对 → 更早的原文轮次。
4. 旁路注入（原 `tryFindArtifactContent`）必须走 `assembleContext()`，并在 `stats.injectedArtifactIds` 留痕。

### B2 `server/context/budget.ts`

```ts
export interface TokenBudget {
  model: string;
  window: number;            // resolveWindow(model)
  reserveOutput: number;     // 给回复预留
  system: number;            // 系统提示词
  memory: number;            // 记忆注入
  tools: number;             // 工具 schema
  history: number;           // 剩余全部分给历史
  /** 实测校准系数：由 P0 采集的 usage 回归得到，默认 1.0，允许 ±20% */
  calibration: number;
}
export function resolveWindow(model: string): number; // 未知模型走保守默认
export function allocate(budget: TokenBudget): { historyChars: number; memoryCount: number };
```

**验收**：用 P0 采集的 `prompt_tokens` 与本地估算对比，误差 ≤20%；超出即回归调参，不允许"估着调优"。

### B3 `server/context/summarize.ts`

```ts
/** 幂等：同一 session 只保留一条最新摘要，重复调用覆盖 */
export async function compactOldTurns(sessionId: string, keepRecent: number): Promise<{
  ok: boolean; summaryVersion: number; coveredTurns: number;
}>;
```
- 保留近 K 轮原文（K 由预算算，建议 6~8）。
- 只压事实与结论，**不删 DB**，原文可按需回查。
- 用便宜模型 + 短提示；失败返回 `ok:false` 并落 trace。

### B4 `server/context/retrieval.ts`

```ts
export function recallForPrompt(
  owner: string,
  query: string,     // 语义见下
  limit: number
): Array<{ key: string; value: string; score: number }>;
```

**`query` 语义（v3 未定义，必须先定）**：取**最近 K 轮（建议 3）用户消息拼接**，而非仅当前句。
理由：首批用例 E1 是多轮指代（"明天上午"），单句 query 无有效关键词 → 必然走回退分支，检索化收益测不出来。

**中文匹配**：无分词器时用「字符 bigram 交集 / 子串包含」，并对长度 <2 的 query 直接走回退。`kind` 权重表需在代码里列明（不写魔数散落各处）。

### B5 工具侧：声明副作用 + 出口裁剪（单一真相源）

```ts
// server/tools/registry.ts
export interface Tool {
  // …现有字段
  /** 是否有副作用（写库 / 外呼 / 出声）。并行调度据此保留串行；禁止在循环里硬编码工具名单 */
  sideEffect?: boolean;
  /** 返回给模型的文本上限（字符），默认 4000；由 guardBudget 的 tools 预算推导 */
  resultMaxChars?: number;
}
```

```ts
// server/tools/registry.ts —— execTool 出口统一裁剪（唯一出口）
const TOOL_RESULT_MAX = 4000;
// …return clipResult(result, tool.resultMaxChars ?? TOOL_RESULT_MAX)
```

### B6 `server/trace/span.ts`

```ts
export type SpanKind = 'think' | 'tool_call' | 'tool_result' | 'observe' | 'degrade';

export function writeSpan(s: {
  runId: string;
  iter: number;
  kind: SpanKind;
  name?: string;
  input?: unknown;
  output?: unknown;
  ms: number;
  tokens?: { prompt: number; completion: number };
}): void;

/** 落库前必过：截断 + 掩码（API Key / Bearer / 邮箱 / 手机号 / 长 URL query） */
export function redactSpan(v: unknown, maxChars?: number): string;
```

**红线不变**：trace 只读，任何情况下不得回灌模型上下文。

---

## C. `agent_spans` DDL 与写入策略

```sql
CREATE TABLE IF NOT EXISTS agent_spans (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  iter INTEGER NOT NULL,
  kind TEXT NOT NULL,          -- think | tool_call | tool_result | observe | degrade
  name TEXT,
  input TEXT,                  -- 已脱敏、已截断
  output TEXT,                 -- 已脱敏、已截断
  ms INTEGER,
  prompt_tokens INTEGER,       -- 新增：来自 usage
  completion_tokens INTEGER,   -- 新增
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_spans_run ON agent_spans(run_id, iter);
```

**写入策略（否则会拖慢主循环 / 无限膨胀）**
1. **批量异步**：内存队列，满 50 条或 50ms 触发一次事务写入。`better-sqlite3` 是同步驱动，禁止每步一条 `INSERT` 打在主循环热路径上。
2. **保留期 30 天**：启动时 + 每日清理 `created_at < now-30d`。
3. **脱敏**：`input/output` 一律经 `redactSpan()`。
4. **`outcome` 真实化**（前置）：`handled | fallback | error`，写进 `agent_runs.outcome`，当前恒为 `'handled'`（`server/llm/bailian.ts:346`、`server/agent.ts:169`）。
5. **usage 采集**：`streamCompat()` 请求体加 `stream_options: { include_usage: true }`，解析末帧 `usage` → span + `agent_runs`。这是 B2 校准的唯一数据源。

---

## D. evals 规格（按层分组，7 条）

断言类型：沿用 `mustInclude / mustNotInclude / toolCalled / noHallucinate`，新增 `maxTokens / eventSeen / outcomeIs`。

| ID | 层 | 输入 | 断言 | 验证的改动 |
|---|---|---|---|---|
| E1 | 提示词行为 | 首轮"设置一个提醒" → 次轮"明天上午" | `mustNotInclude`（"提醒什么事"）+ `toolCalled(set_reminder)` | v3 原用例 1；**注意它考的是上下文/提示词，不是记忆检索** |
| E2 | 提示词行为 | 睡前提醒 → "现在不想睡，想听歌" | `toolCalled(play_music, control_music)` 或 `mustInclude`（推迟/改期） | v3 原用例 2 |
| E3 | 提示词行为 | 任何缺信息场景 | `mustNotInclude`（空泛反问句式）+ `mustInclude`（具体方案） | v3 原用例 3 |
| E4 | L0 循环 | "打开《X》" | `toolCalled(open_artifact)` + `mustNotInclude`（"这次是真的"） | v3 原用例 4 |
| E5 | **L1 上下文** | 造 30 轮历史，第 2 轮埋事实，末轮提问 | `mustInclude(事实)`；`stats.historyChars ≤ budget.history` | 滚动摘要不丢早期（md §7 P2 判据） |
| E6 | **L1 上下文** | 注入超长工具结果（>8000 字符） | `maxTokens(下一轮 messages) ≤ window - reserveOutput`；近 K 轮未被裁 | `guardBudget` 生效且不过度裁剪 |
| E7 | **L0/观测 兜底路径** | 模拟引擎 120s 无响应 | `outcomeIs('fallback')` + `eventSeen('notice')` 恰一次 | 兜底可观测（当前完全无覆盖） |

**规则**
- 每条用例标记"验证哪一层"；改哪一层，必须跑该层 + 全量。
- 结果落盘 `evals/report.json`，与上一版比对，输出"变好/变坏"清单。
- 缺 API Key 时输出 `SKIPPED` 并以非零码退出，**不得静默算绿**。

---

## E. P0 开工清单（顺序执行，含验收）

| 步 | 动作 | 验收 |
|---|---|---|
| **P0-0** | `git init` + `.gitignore` 生效（确认 `data/*.db*`、`node_modules`、`*.log` 已忽略）+ 基线提交 | `git log` 有基线；`git status` 干净 |
| P0-1 | 尾部核对一次真实响应含 `usage` → `streamCompat` 加 `stream_options:{include_usage:true}` → 落 `agent_runs(prompt_tokens, completion_tokens)` | 跑一轮对话，库里有非零 token |
| P0-2 | `outcome` 真实化：`handled / fallback / error` | 人为制造一次 Key 失效，落 `error` |
| P0-3 | `agent_spans` DDL + `writeSpan` + 脱敏 + 保留期 + 面板步级 trace | 一轮对话能看到每步入参/出参/耗时/tokens |
| P0-4 | evals 骨架 + E1–E7 + `npm run eval` | 改一条 prompt 词能看见"变好/变坏"；缺 Key 时 SKIPPED |
| P0-5 | 冒烟：`npm test` + `npm run eval` | 两者均绿并留档 |

> P0-0 的理由：当前目录**不是 git 仓库**且无 CI，而 P1 计划里"保留旧函数一版可切回""改前改后灰度对比"都依赖版本可回退 —— 安全网不能建在没有地基的地方。

---

## F. 风险表增补（并入 md §9）

| 风险 | 对策 |
|---|---|
| trace 是新建的数据面，却无治理 | `writeSpan` 内置脱敏 + 截断；保留期 30d + 清理任务；上云前补鉴权与租户隔离 |
| 无 VCS / CI 时"全绿"不可信 | P0-0 先 `git init`；eval 结果落盘可比对；缺 Key 如实 SKIP，不假绿 |
| 并行工具致 `tool_call_id` 错配 | 按 id 回填 `messages`，禁止按到达顺序 append；`Tool.sideEffect` 未声明前不并行 |
| 预算系数无实测依据 | 用 P0-1 的 usage 校准，误差 >20% 触发回归 |

---

## G. 每阶段验证方式

```bash
# P0 之后（每阶段强制）
npm test
npm run eval          # 新增；结果存 evals/report.json，与基线 diff

# 仅 P1 之后：上下文层对照
npm run eval -- --layer=L1 --compare=evals/baseline/report.json

# 真实引擎冒烟（需 Key，可选）
npm run test:live
```

**P1 关键判据**：`assembleContext()` 是唯一上下文出口（全仓 grep 无第二处直接拼 `messages` 的注入点）；实测 token 与预估误差 ≤20%；E5/E6 通过且兜底率不上升。

---

## H. v3 中保留不动的判断（勿因本次修订改动）

1. trace **只读**、禁止回灌上下文（自我污染红线）。
2. evals **不用 LLM 打分**，用可复现规则。
3. 装配器**唯一出口**的强约束（本次只是把它补齐，而不是放松）。
4. P0 先建安全网、再动刀的顺序。
5. Skills 排在上下文引擎之后的取舍理由（组织性收益，不解决"聊得久"）。

---

## I. HTML 呈现层同步修订（`architecture-v3.1.html` 已实施）

| 项 | v3 | v3.1 |
|---|---|---|
| `--muted-2` 对比度 | `#6b7f9f`（约 4.2:1，低于 AA） | `#7d90ad`（约 5.2:1） |
| `font-family` 拼写 | `ui.monospace`（字体回退） | `ui-monospace` |
| `.sse` / `.evo` / `.lbl` / `.er` / `.next` | 有类无样式（靠内联兜底） | 已补类定义 |
| 层级编号 | 与 md §5/§6 标题冲突 | 图内统一 L4=Evals&Trace、L3=Skills，并注明以 §2 图为准 |
| footer | 只说"依据 md 绘制" | 标注版本 + 唯一真相源 + 行号快照日期 |

---

*本增补为工程评审产出，不构成对 v3 设计的否定；分歧点均附源码位置，可逐条复核。*
