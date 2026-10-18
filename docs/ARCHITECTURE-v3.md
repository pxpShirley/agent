# 栖光 Agent 架构演进设计（v3 · 开发指导书）

> 本文是**后续开发的总纲**。每一条设计都锚定现有代码位置、给出数据结构、接口签名与迁移步骤。
> 范围外（本期不做）：鉴权 / 多用户隔离、沙箱执行提权。
> 事实基线：`MAX_AGENT_ITERATIONS=6`、`buildHistory(maxTurns=12, maxChars=6000)`、`MEMORY_CONTEXT_LIMIT=12`、`MEMORY_SNIPPET_MAX=160`、提示词 11 条行为约束 + 5 条输出纪律、工具 13 个。

---

## 0. 设计原则

| 原则 | 含义 |
|---|---|
| **单一真相源** | 一个概念只在一处定义（已是 `tools/registry.ts` 的做法，推广到记忆与Skills） |
| **结构化优先** | 模型自由文本不得进入判定链路，一律归一为结构化列 |
| **优雅降级** | 任一环失效都可回退，但**降级必须可观测**，不静默 |
| **可测优先** | 任何改动 prompt/模型/上下文策略，都必须能用 evals 证明是变好 |
| **能力解耦** | 新增能力优先走注册表/Skill，不改主循环 |

---

## 1. 现状诊断（已核实）

**做对的（保持不动）**
- ReAct 循环标准形态，限6 轮；`execTool` 带 timeout+retry；6s 客户端看门狗。
- 工具注册表单源：提示词清单 / 下发 schema / 实际执行三者同源派生。
- 编排层字段已预留（`systemOverride / role / omitTools / maxIter`）。

**四块短板（本设计要解决的）**
1. **上下文管理只有截断、没有压缩** —— `buildHistory` 双阈值硬截断；无滚动摘要、无记忆相关性检索、无 token 预算。
2. **记忆是"注入式"而非"检索式"** —— 只取最近 12 条、按时间序，与当前问题相关性为零。
3. **可观测有表无视图** —— `agent_runs` 已记录 `tools_used/outcome/model`，但无 trace 视图，且**主循环内部决策未落span**。
4. **无回归网** —— `scripts/` 下是一次性探针，改 prompt/模型无法判断整体是变好还是变坏。

---

## 1.5 L0 主循环评估与三处补强（L0+）

**结论：L0 骨架设计正确且规范**，与 OpenAI function calling / DeepSeek / Claude tool-use 的标准 ReAct 循环一致，**不需要重写**。已做对的关键点（改动时勿破坏）：

| 已做对 | 位置 |
|---|---|
| 迭代上限 6 轮 | `bailian.ts` `MAX_AGENT_ITERATIONS=6` |
| 流式吐字 | `for await (chunk of streamCompat(...))` |
| 收敛判据`if (!toolCalls.length) break`（不硬跑满轮次） | 循环内 |
| `tool_calls` / `role:'tool'` **严格回写**（DeepSeek 对 `content:null` 更严格→用空串） | 循环内 |
| `ask_user` 人在环：中断本轮等用户决策 | `ask_user` 分支 |
| 180s 总超时 | `AbortController` |

**三处补强（投入小、收益大，P1 落地）**

1. **并行执行工具** ✅ **已落地（2026-10-08）**
   现状 `for (const tc of toolCalls) { await execTool(...) }` **串行**，多工具耗时会叠加。
   **已实施**：`bailian.ts` 主循环改为双分支——
   - 新增 `READ_ONLY_TOOLS` 白名单（`recall_memory / get_schedule / web_lookup / open_artifact`）；
   - 当一轮内 `toolCalls.length > 1` 且**全部**命中白名单时，用 `Promise.all` 并发；
   - 其余（写库 / 音乐副作用 / `ask_user` 中断本轮）**保留串行**，避免竞态与语义错乱。
   **关键约束**：tool 消息必须按 `tool_calls` **原顺序**回填（并发完成顺序不确定），
   否则 `tool_call_id` 与 `assistant.tool_calls` 错位会让下一轮模型串味。
   安全性依据：`execTool` 内部 try/catch 吞掉所有异常并返回字符串，**永不 reject**，故 `Promise.all` 不会整轮失败。
   ⚠️ 后续新增纯读取工具时，记得加进白名单，否则会退化成串行（安全但慢）。

2. **过程可观测（最小 span）** ✅ **已落地（2026-10-08）**
   `agent_runs` 原只记一轮结果（用了哪些工具），看不到"跑了几轮、几轮是并发的、耗时多少"，
   于是「并行执行 / 记忆预注入到底省了几轮」永远只是感觉，无法回归。
   **已实施**：`agent_runs` 增加 4 个标量列（`iterations` / `tool_calls_count` / `parallel_rounds` / `latency_ms`，
   含旧库 `ensureColumn` 迁移），`bailian.ts` 主循环内累加；新增 `db.getLoopStats()` + `GET /api/admin/loop-stats`。
   **为什么只要这四个标量**：能回答"平均几轮 / 几轮并发 / 多慢"，足以验证优化成效；
   完整的 `agent_spans`（每次工具调用的入参/耗时/结果摘要）留到 L4 Trace 阶段，那时才需要回放。
   ⚠️ 旧记录这四个字段为 null，`getLoopStats` 会用 `spanRuns` 单列出来，不把均值拉成 0。

3. **轮内 token 预算守卫**
   现状仅靠固定 6 轮 + 客户端 6s 看门狗。若一轮工具返回大量内容（`get_schedule` / `web_lookup`），会撑爆下一轮。
   改法：每轮迭代前检查消息累积 token，超阈值则裁剪最旧工具结果或提前收敛（复用 L1 预算器）。
   优先级**低于**上面两项：先把「真的省了几轮」测出来，再决定要不要加复杂度。

### 1.6 记忆预注入：注入量怎么定（2026-10-08 决策）

**问题**：`buildMemoryContext` 原为"取最近 12 条 + 每条截断 160 字符"。条数是**常数**——
与本轮问什么无关，也与每条多长无关。后果：长记忆挤掉短记忆、陈旧的高频记忆挤掉刚记住的，
模型常拿不到相关的那几条，只能**再花一整轮**去调 `recall_memory`。

**决策：注入量 = min(相关性截断后的条数, 字符预算允许的条数)**

| 维度 | 旧 | 新 |
|---|---|---|
| 计量单位 | 条数（常数 12） | **字符预算**（1800，可 `MEMORY_CHAR_BUDGET` 覆盖） |
| 条数 | 前提（固定 12） | **结果**（贪心累加到预算用完为止） |
| 排序 | `updated_at DESC` | 相关性 0.6 + 新鲜度 0.3 + 类型 0.1 |
| 输入 | 只有 owner | **必须带本轮原话** `query`（不带就退化成旧行为） |

**为什么预算是 1800 而不是更大**：真正的风险不是撑爆 64K 窗口，而是**每轮都付费**——
记忆区块每多 1000 字符，每一轮对话都要多付这 1000 字符的输入成本。
1800 ≈ 12 条 × 150 字符，是"够让模型认出这个人"的最小充分值。

**同源硬约束**：`agent.ts` 的预注入与 `registry.ts` 的 `recall_memory` **共用 `server/memory.ts`** 的
`selectMemories()`。曾经两处各写一份（一个 substring 过滤、一个取最近 N），排序不一致必然漂移。
差异只在单条截断：注入路径 160 字符（省成本），工具路径 400 字符（显式查，要完整）。

**配套提示词纪律（已加进 `buildSystemPrompt`）**：
- 互不依赖的工具调用必须在**同一次回复里一起发出**（否则并行执行白做了）；
- 已在「关于这位用户」里给出的记忆**严禁再调一次 `recall_memory`**确认。

**实测（2026-10-08，DeepSeek）**：
- "假期快结束了，今晚我该怎么安排？" → **0 次工具调用**（改前会先 `recall_memory` 一轮）
- "我现在还不想休息，想听歌" → 直接 `play_music`，1 次工具调用，无多余回看
- "帮我安排周末，看看安排、回忆偏好" → `get_schedule` + `recall_memory` **并发一轮完成**，`parallelRounds = 1`
- 回归：`scripts/memory-select-probe.ts` 26 项全绿

---

## 2. 目标架构总览

```
                 ┌───────────────────────────────┐
                 │  L4  Evals & Trace 评估层     │  ← 一切改动的安全网
                 └───────────────┬───────────────┘
   ┌─────────────┐   ┌───────────▼───────────┐   ┌──────────────┐
   │ L3 Skills   │   │  L1  Context Engine  │   │ L2  Memory   │
   │ 能力包化    │──▶│ 预算·摘要·检索·装配 │◀──│ 分层+检索    │
   └─────────────┘   └───────────┬───────────┘   └──────────────┘
                                 │
                     ┌───────────▼─────────────┐
                     │ L0  Agent 主循环（不变） │
                     └─────────────────────────┘
```

---

## 3. L1 · Context Engine（最高优先级）

**目标**：不再靠"截断"维持上下文，改为**预算驱动的装配器**。

### 3.1 Token 预算分配器

新增 `server/context/budget.ts`：

```ts
export interface TokenBudget {
  model: string;
  window: number;        // 模型上下文窗口
  reserveOutput: number; // 给回复预留
  system: number;        // 系统提示词
  memory: number;        // 记忆注入
  tools: number;         // 工具 schema
  history: number;       // 剩余全部分给历史
}

/** 按模型读取窗口上限；未知模型走保守默认值 */
export function resolveWindow(model: string): number;

export function allocate(budget: TokenBudget): {
  historyChars: number;   // 历史可占字符数（中文 ≈ 1.5 字符/token，保守 ×1.6）
  memoryCount: number;    // 记忆可注入条数
};
```

**规则**：
- `window`：deepseek-chat 取 64k 级别保守值（配置化，不硬编码）。
- `historyChars = window - reserveOutput - system - tools - memory` 后换算成字符。
- **禁止**再出现"12 轮 / 6000 字符"这类魔法数字，全部由预算算出。

### 3.2 滚动摘要

新增 `server/context/summarize.ts`，落库到 `messages.summary` 或新表 `session_summaries`：

```ts
export interface TurnBudget { maxChars: number }
// 当「本轮历史」预算不足时，把最老的若干轮压缩成一段摘要
export async function compactOldTurns(sessionId: string, keepRecent: number): Promise<void>;
```

**规则**：
- 保留最近 K 轮原文（K 由预算算，建议 6~8），更早的轮次压缩为 `【历史摘要】…`。
- 摘要**异步生成**（不阻塞当前轮），用便宜模型/短提示，只压事实与结论，不压情绪。
- 幂等：同一session 只保留一条最新摘要，重复调用覆盖。

### 3.3 记忆检索化（把"注入"换成"召回"）

现有 `buildMemoryContext(owner)` 是**按时间取最近 12 条**（`agent.ts:62`）。改为相关性召回：

```ts
// server/memory/retrieval.ts
export function recallForPrompt(
  owner: string,
  query: string,
  limit: number
): Array<{ key: string; value: string; score: number }>;
```

**打分**（轻量、可解释，暂不上向量库）：
`score = 关键词重合度 * 0.6 + recency * 0.3 + kind权重 * 0.1`
- 无匹配时回退"取最近 N 条"，保证行为不退化。
- 预留接口：未来可替换为 embedding 检索，实现层不变。

### 3.4 装配器（唯一出口）

新增 `server/context/assemble.ts`：

```ts
export interface AssembledContext {
  system: string;
  memory: string;
  tools: unknown[];
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  budget: TokenBudget;
  stats: { historyChars: number; memoryCount: number; compacted: boolean };
}

export function assembleContext(opts: {
  owner: string;
  sessionId: string;
  current: string;
  toolDefs: unknown[];
  model: string;
}): AssembledContext;
```

**这是主循环唯一获取上下文的地方** —— `bailian.ts` 里的 `buildHistory` 调用迁移到这里。

**迁移步骤**
1. 新增 `server/context/*`（budget → summarize → retrieval → assemble），不动 `bailian.ts`。
2. 在 `runBailianAgentTurn` 里用 `assembleContext()` 替换 `buildHistory()` + `buildMemoryContext()`。
3. 保留旧函数一个版本作为 fallback，出问题可切回。
4. 用 evals 对比改前/改后（见 §5）。

---

## 4. L2 · Memory 分层与检索

### 4.1 分层

| 层 | 存储 | 生命周期 | 进上下文方式 |
|---|---|---|---|
| 会话记忆 | `messages` | 随会话 | 预算内滚动摘要 + 近轮原文 |
| 长期画像 | `memories` | 跨会话 | **相关性召回**（§3.3） |
| 项目事实 | `artifacts` / `tracks` | 长期 | 按需工具读取，不注入 |
| 运行轨迹 | `agent_runs` | 长期 | **不进上下文**，只做可观测 |

### 4.2 写记忆纪律

- 模型调`save_memory` 时，服务端统一做**归一 + 去重**（复用 `normKey`），避免同义反复。
- 记忆写入即结构化：`key/value/kind/updated_at`，与"自由文本不得进判定链路"一致。

---

## 5. L3 · Evals 与 Trace（安全网，必须先于大改）

### 5.1 Trace（可观测）

**问题**：`agent_runs` 只记录一轮的最终结果，主循环内部"为什么调这个工具"看不见。

**做法**：新增 `agent_spans` 表，主循环每步落一条 span：

```sql
CREATE TABLE IF NOT EXISTS agent_spans (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  iter INTEGER NOT NULL,
  kind TEXT NOT NULL,        -- think | tool_call | tool_result | observe
  name TEXT,                 -- 工具名/事件名
  input TEXT,
  output TEXT,
  ms INTEGER,
  created_at TEXT NOT NULL
);
```

**接入**：治理面板新增「本轮 trace」视图，按 iter 展开每一步耗时与工具入参/出参。

**红线**：trace 是**只读观测**，任何情况下不得把 trace 文本回灌进模型上下文（会自我污染）。

### 5.2 Evals（回归网）

**已落地（2026-10-09）**：`evals/cases.ts` + `scripts/run-evals.ts` + `npm run eval`。

```
evals/cases.ts          用例（输入 + 期望 + why）
scripts/run-evals.ts    运行器：临时库隔离 → 驱动真实引擎 → 规则判定
```

**判定方式**（不用 LLM 打分，用可复现的规则）：
- `mustInclude` / `mustIncludeAny` / `mustMatchAny`（正则，表达"出现了具体时间"这类**结构**）
- `mustNotInclude`：禁用话术（空泛反问、自我否定）
- `toolCalled` / `toolCalledAny` / `toolNotCalled`
- `noSelfDenial`：不得出现"刚才其实没做 / 这次是真的"

**首批 4 条（对齐已知痛点，实测 4/4 通过）**：
1. `multiturn-anaphora` 多轮指代：「明天要去国贸开会」→「帮我设个提醒」必须接住上文。
2. `deflect-to-music` 婉拒场景：「不想休息想听歌」应放歌，不是劝睡。
3. `no-empty-question` 空泛反问防线：零上下文也禁止把球踢回去（**实测仍有约 1/5 概率违规**）。
4. `artifact-must-open` 产物读取：内容必须为真（canary 串把关），且不得重建。

**三条踩坑（都已固化在代码注释里）**：
1. **兜底必须判失败**。引擎 fetch 失败时会回退本地 mock 并正常吐字——不检测 `done.fallback` 的话，
   网络一抖就变成一片假绿，测的是 mock 不是模型。
2. **canary 必须模型猜不出来**。第一版用「颐和园·傍晚昆明湖」，模型没读文件也"说中了"——
   因为国庆+北京本来就能猜到。现在掺随机暗号，命中才证明真读过。
3. **断言要测"用户得到了什么"，不是"内部走了哪条路"**。第 4 条最初写成 `toolCalled:[open_artifact]`，
   结果挂了：引擎早有服务端兜底 `tryFindArtifactContent()`（bailian.ts:291）把真内容拼进用户消息，
   模型根本不用调工具也编不了。那是能力层的硬保证，比"求模型记得调工具"可靠——
   断言若绑死实现路径，就会把一个更好的实现判成失败。

`npm test` 跑单测（毫秒级、零成本）+ `npm run eval` 跑 evals（真调模型、有成本）——
**两者分开**是故意的：混在一起的结果是大家为了省时间把 test 也关掉。

---

## 6. L4 · Skills 能力包化（中期）

**问题**：能力硬编码在 registry + 提示词里，加一个域要改多处。

**目标**：把"某一类任务的做法"抽成可插拔包。

```ts
// server/skills/types.ts
export interface Skill {
  name: string;
  description: string;        // 何时用（进系统提示的能力清单）
  loadInstructions: () => string; // 用时展开的详细做法（按需进上下文）
  tools?: string[];           // 需要的工具
}
```

**约定**：
- Skill 说明书是**代码**，不是运行时文件（沿用单进程部署的现状）。
- 提示词只列 `name + description`（省 token），命中后才 `loadInstructions()`。
- 首批候选：`睡眠作息`、`行程规划`、`产物整理`。

**为什么排在后**：能力包化是组织性收益，不解决当下的"聊得久"。先做 L1。

---

## 7. 落地顺序（每步都可独立验证）

| 阶段 | 做什么 | 完成判据 |
|---|---|---|
| **P0** | Trace 表 + span 落库 + 治理面板 trace 视图 | 一轮对话能看到每步工具入参/出参/耗时 |
| **P0** | ✅ **Evals 骨架已落地**（`evals/cases.ts` + `npm run eval`，4 条用例实测 4/4） | 改prompt 后能一条命令判断变好/变坏 |
| **P0** | ✅ **主循环最小 span 已落地**（`agent_runs` 四列 + `/api/admin/loop-stats`） | 能看到平均迭代/并发/耗时 |
| **P0** | Trace 表 +回放级 span + 治理面板 trace 视图 | 一轮对话能看到每步工具入参/出参/耗时 |
| **P1** | ✅ **多工具并发执行已落地**（只读白名单 + `Promise.all`） | `parallel_rounds > 0` 且 tool 消息按原序回填 |
| **P1** | ✅ **记忆检索化（`selectMemories`）已落地** | `scripts/memory-select-probe.ts` 26 项全绿；相关记忆零工具调用即可命中 |
| **P1** | `server/context/budget.ts` + `assemble.ts` + **L0+ ③ 轮内预算守卫** | 历史长度由预算决定；轮内超预算可裁剪 |
| **P2** | 滚动摘要 `compactOldTurns` | 长会话（>30 轮）早期内容仍能被引用 |
| **P3** | Skills 包化（先抽1~2 个域试点） | 新增能力不改编排主流程 |

**每阶段强制**：`npm test` + `npm run eval` 全绿，且对照 evals 确认无退化。

---

## 8. 明确不做（本轮）

- 鉴权 / 多用户隔离（owner='guest' 现状保留，上云前必须补）。
- 沙箱执行提权（自用单机场景不急）。
- 多Agent 全铺开（`role/omitTools` 字段已预留，等上下文引擎稳后再扩）。

---

## 9. 风险与对策

| 风险 | 对策 |
|---|---|
| 上下文引擎改动导致回复质量下降 | Evals 先上，灰度对比，改前改后各跑一遍 |
| 摘要丢关键信息 | 摘要只压事实/结论，且保留原文可查（不删除 DB） |
| 记忆检索召回不准 | 先关键词+recency，保留"取最近 N 条"回退；后续再上向量 |
| Token 成本上升 | 预算器统一限流；摘要用便宜模型；记忆条数受 `memoryCount` 硬约束 |