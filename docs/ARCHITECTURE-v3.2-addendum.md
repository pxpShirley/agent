# 目标态架构 v3.2 增补：设计修订 · 接口契约 · 落地清单

> 配套：`docs/architecture-v3.2.html`
> **口径声明**：本文件评审的是**迭代后的目标态**（`ARCHITECTURE-v3.md` 所描述的目标架构 + `architecture-v3.html`），
> 不是现状说明书。正文 A~H 全部是**目标态自身是否自洽、是否可验收**的问题；
> 涉及"已落地标注是否真实"的内容全部收在 **附录 I 起跑线校验**，它只决定从哪里出发，不构成对目标态的结论。
> 本文件不改写 `ARCHITECTURE-v3.md`，只给「按位置替换 / 新增」的补丁。定稿后建议并入 md 升版为 v3.2，只留一份真相源。

---

## 0. 结论摘要

- 目标态的**分层、四层记忆划分、P0→P3 顺序、trace 只读红线、evals 不用 LLM 打分**——全部保留，不动。
- 目标态有 **8 处自洽性/可验收性缺口**：D1–D3 属阻断级（照此落地会在 P1 撞上），D4–D6 属高，D7–D8 属中。
- 最短修法：把"唯一出口 + 双 API + token 采集"三件事写进目标态，把并行工具降级并补元数据，把 evals 按层分组。

---

## A. 目标态设计修订（D1–D8）

### D1【阻断】「唯一出口」自相矛盾 → 需要在目标态里给旁路定归属

| 项 | 内容 |
|---|---|
| 目标态现状写法 | §3.4「`assembleContext()` 是主循环唯一获取上下文的地方」，但目标态未提及产物注入旁路 |
| 问题 | 产物真实内容由 `tryFindArtifactContent()` 直接拼进 user 消息（`server/llm/bailian.ts:295-306`，调用点 `:358`）。目标态落地后，上下文有**两个**注入点 —— 铁律第一条就破 |
| 建议目标态写法 | 把三处注入点统一登记为装配器职责：`buildHistory()`（历史）、`buildMemoryContext()`（记忆）、`tryFindArtifactContent()`（产物）；并在 `stats.injectedArtifactIds` 留痕 |
| 可验收 | 全仓 grep：除 `assembleContext()` 外，无第二处构造 `messages` 初始数组 |

### D2【阻断】装配器契约同步/异步冲突 → 目标态拆成两个 API

| 项 | 内容 |
|---|---|
| 目标态现状写法 | `assembleContext(...): AssembledContext`（同步）＋ `async compactOldTurns()` ＋ L0+「每轮迭代前检查消息累积 token」 |
| 问题 | ① 同步装配读不到异步摘要，目标态未定义此时行为；② "每轮检查预算"意味着装配可能发生在 iteration 内，与"每轮请求装配一次"的语义冲突 |
| 建议目标态写法 | 拆为 `assembleContext()`（turn 级·同步·唯一出口）与 `guardBudget(messages, budget)`（iteration 级）；装配**只读已生成摘要**，未就绪则 `compacted=false` + 后台补做 |
| 可验收 | 契约文档中两个函数签名并存；`compacted` 与 `summaryVersion` 在 trace 中可见 |

### D3【阻断】预算器缺测量闭环 → 目标态必须自带上限校准

| 项 | 内容 |
|---|---|
| 目标态现状写法 | §3.1「`window` 配置化、按窗口换算、禁止 12 轮/6000 字符这类魔法数字」 |
| 问题 | 目标态没有安排 token 采集（未解析 `usage`、无 token 列）。没有实测值，预算只能靠"中文≈1.5 字符/token、保守 ×1.6"这类系数 —— **等于把 6000 换成 1.6**，目标态无法自证"更科学" |
| 建议目标态写法 | P0 增加：`stream_options:{include_usage:true}` → 解析末帧 `usage` → 落 `agent_runs`/`agent_spans`；`TokenBudget.calibration` 由实测回归得出，误差 >20% 触发回归 |
| 可验收 | 库里存在非零 `prompt_tokens`；估算与实测误差 ≤20% |

### D4【高】召回 query 语义缺失，且与目标态自己的验收用例错配

| 项 | 内容 |
|---|---|
| 目标态现状写法 | `recallForPrompt(owner, query, limit)`；首批用例 1 为"多轮指代：设置提醒 → 明天上午" |
| 问题 | `query` 未定义来源。若取"当前这一句"，在多轮指代场景几乎没有可匹配关键词 → 必然回退"取最近 N 条" → **该用例无法证明检索化的收益**，目标态的验收与目标态的功能不对齐 |
| 建议目标态写法 | 定义 `query = 最近 K 轮（建议 3）用户消息拼接`；中文匹配用字符 bigram / 包含匹配，长度 <2 直接回退；`kind` 权重表集中定义 |
| 可验收 | 新增一条 L2 用例：埋一条 5 轮前的相关记忆，验证被召回；同时验证无关记忆不被硬塞 |

### D5【高】L4 安全网盖不住 L1/L2

| 项 | 内容 |
|---|---|
| 目标态现状写法 | 首批 4 条用例：多轮指代 / 婉拒放歌 / 空泛反问防线 / 产物读取 |
| 问题 | 其中 3 条考的是**提示词行为**，只有第 4 条沾 L0。目标态把 L4 当"一切改动的安全网"，但改上下文引擎时没有回归网 |
| 建议目标态写法 | 用例按层分组（L0 / L1 / L2 / 提示词 / 兜底路径），扩到 E1–E7，新增 `maxTokens / eventSeen / outcomeIs` 断言 |
| 可验收 | 每个待改的层至少 1 条用例；缺 API Key 时输出 SKIPPED，不得算绿 |

### D6【高】并行工具：收益被高估、优先级错配、前置缺失

| 项 | 内容 |
|---|---|
| 目标态现状写法 | §1.5 补强 1「并行执行工具（最高优先）」，改法为 `Promise.all` + 副作用工具串行 |
| 问题 | ① 每轮一次的 LLM 流式调用**天然不可并行**；`better-sqlite3` 是同步驱动，DB 类工具并发只是排队 → 真正受益的只有网络型工具；② "有副作用的（ask_user / 写库 / 音乐）保留串行"所需的**分类在目标态里没有数据来源**，落地会退化成硬编码名单，违反目标态自己的"单一真相源"；③ 并行后必须按 `tool_call_id` 回填 `messages`，否则配对失败 |
| 建议目标态写法 | 降为 **P2**；先给 `Tool` 加 `sideEffect` 元数据（注册表单一真相源）；循环内按 id 回填而非按到达顺序 append |
| 可验收 | 若实施：并发调用 2 个工具，`messages` 中 `tool` 结果与 `tool_call_id` 一一对应 |

### D7【中】Skills 与目标态"单一真相源"原则冲突

| 项 | 内容 |
|---|---|
| 目标态现状写法 | `Skill{ name, description, loadInstructions, tools?: string[] }` |
| 问题 | 现有能力清单严格由 `activeToolDefs()` 派生且与提示词同源（`server/agent.ts:76-79` 的注释正是为了修"清单不同源"的旧坑）。`Skill.tools` 引入第二份清单 |
| 建议目标态写法 | Skill 只提供 instructions + 触发描述；能力裁剪走注册表 `enabled(ctx)` |
| 可验收 | 全仓只有一处产生"可用工具名列表"的函数 |

### D8【中】观测数据面缺治理规则

| 项 | 内容 |
|---|---|
| 目标态现状写法 | §5.1 只给 DDL 与"面板展开"，未定义写入方式 / 保留期 / 脱敏 |
| 问题 | 目标态要新建数据面，却把三个必须现在决定的事留空：同步驱动下逐条 insert 打在主循环热路径；无保留期会线性膨胀；`input/output` 会存下用户原文、工具入参、邮件内容 |
| 建议目标态写法 | 内存队列 + 批量事务写入；保留期 30d + 清理任务；`redactSpan()` 截断 + 掩码（key/Bearer/邮箱/手机号） |
| 可验收 | 压测一轮对话，span 写入不显著影响单轮耗时；30d 前数据可被清理任务删除 |

---

## B. 新增接口契约

### B1 `server/context/assemble.ts` —— 双 API

```ts
/** turn 级：主循环获取上下文的唯一出口。**同步**（不得 await 摘要生成）。 */
export interface AssembledContext {
  system: string;
  memory: string;
  tools: unknown[];
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** 本次注入的当前用户消息（含产物真实内容等旁路注入，统一在此拼装） */
  current: string;
  budget: TokenBudget;
  stats: {
    historyChars: number;
    memoryCount: number;
    /** false = 摘要未就绪，本轮用原文顶着 */
    compacted: boolean;
    summaryVersion: number;
    /** 旁路注入的产物 id，避免"黑箱注入" */
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

/** iteration 级：轮内预算守卫。可裁最旧 tool 结果，不得动 system 与近 K 轮。 */
export function guardBudget(
  messages: Array<Record<string, unknown>>,
  budget: TokenBudget
): { messages: Array<Record<string, unknown>>; truncated: number; overBudget: boolean };
```

**约定**
1. `assembleContext()` 同步：只读**已生成**摘要；缺失/过期 → `compacted:false` + `void compactOldTurns(...)` 后台补做。
2. 摘要失败**不回滚**本轮，但必须落 trace（降级可观测，不静默）。
3. `guardBudget()` 在每轮 `streamCompat()` 之前调用；裁剪顺序：最旧 tool 结果 → 最旧工具调用对 → 更早原文轮次。
4. 三处注入点（历史 / 记忆 / 产物）全部经装配器，`stats.injectedArtifactIds` 留痕。

### B2 `server/context/budget.ts`

```ts
export interface TokenBudget {
  model: string;
  window: number;          // resolveWindow(model)
  reserveOutput: number;
  system: number; memory: number; tools: number; history: number;
  /** 实测校准系数：由 P0 采集的 usage 回归得到，默认 1.0 */
  calibration: number;
}
export function resolveWindow(model: string): number;   // 未知模型走保守默认
export function allocate(b: TokenBudget): { historyChars: number; memoryCount: number };
```

### B3 `server/context/summarize.ts`

```ts
/** 幂等：同 session 只保留一条最新摘要，重复调用覆盖 */
export async function compactOldTurns(sessionId: string, keepRecent: number): Promise<{
  ok: boolean; summaryVersion: number; coveredTurns: number;
}>;
```
保留近 K 轮原文（建议 6~8）；只压事实与结论；**不删 DB**；失败返回 `ok:false` 并落 trace。

### B4 `server/context/retrieval.ts`

```ts
export function recallForPrompt(
  owner: string,
  query: string,   // = 最近 K 轮用户消息拼接（K 建议 3）
  limit: number
): Array<{ key: string; value: string; score: number }>;
```
中文匹配：字符 bigram 交集 / 子串包含；`query` 有效长度 <2 直接回退。`kind` 权重表集中定义。

### B5 工具侧：声明副作用 + 出口裁剪

```ts
export interface Tool {
  // …现有字段
  /** 是否有副作用（写库/外呼/出声）。并行调度据此保留串行；禁止在循环里硬编码名单 */
  sideEffect?: boolean;
  /** 返回给模型的文本上限（字符），默认 4000 */
  resultMaxChars?: number;
}
```
`execTool` 出口统一裁剪（延续"单一出口"）。

### B6 `server/trace/span.ts`

```ts
export type SpanKind = 'think' | 'tool_call' | 'tool_result' | 'observe' | 'degrade';

export function writeSpan(s: {
  runId: string; iter: number; kind: SpanKind; name?: string;
  input?: unknown; output?: unknown; ms: number;
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
  prompt_tokens INTEGER,       -- D3 的数据源
  completion_tokens INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_spans_run ON agent_spans(run_id, iter);
```

1. **批量异步**：内存队列，满 50 条或 50ms 触发一次事务写入（同步驱动下禁止逐条 insert 打热路径）。
2. **保留期 30 天**：启动时 + 每日清理。
3. **脱敏**：`input/output` 一律经 `redactSpan()`。
4. **usage 采集**：`streamCompat()` 请求体加 `stream_options: { include_usage: true }`，解析末帧 `usage`。
5. **`outcome` 三态**：`handled | fallback | error`（目标态质量口径的基础）。

---

## D. evals 规格（按层分组，7 条）

断言类型：`mustInclude / mustNotInclude / toolCalled / noHallucinate` + 新增 `maxTokens / eventSeen / outcomeIs`。

| ID | 层 | 输入 | 断言 | 验证的目标态能力 |
|---|---|---|---|---|
| E1 | 提示词行为 | 首轮"设置一个提醒" → 次轮"明天上午" | `mustNotInclude`(提醒什么事) + `toolCalled(set_reminder)` | 上下文可用性（**非**记忆检索） |
| E2 | 提示词行为 | 睡前提醒 → "不想睡，想听歌" | `toolCalled(play_music/control_music)` 或 `mustInclude`(推迟) | 婉拒场景 |
| E3 | 提示词行为 | 缺信息场景 | `mustNotInclude`(空泛反问) + `mustInclude`(具体方案) | 输出纪律 |
| E4 | L0 循环 | "打开《X》" | `toolCalled(open_artifact)` + `mustNotInclude`(这次是真的) | 工具优先于复述 |
| E5 | **L1 上下文** | 30 轮历史，第 2 轮埋事实，末轮提问 | `mustInclude(事实)`；`historyChars ≤ budget.history` | 滚动摘要不丢早期 |
| E6 | **L1 上下文** | 注入 >8000 字符工具结果 | `maxTokens(下一轮) ≤ window - reserveOutput`；近 K 轮未裁 | guardBudget 生效 |
| E7 | **L0/观测 兜底** | 模拟 120s 无响应 | `outcomeIs('fallback')` + `eventSeen('notice')` 恰一次 | 兜底可观测 |

规则：每条标注"验证哪一层"，改哪层跑该层 + 全量；结果落 `evals/report.json` 与上版比对；缺 Key 输出 SKIPPED 并非零退出。

---

## E. 落地清单（目标态，顺序执行）

| 步 | 动作 | 验收 |
|---|---|---|
| **P0-0** | 版本控制就位 + 基线冻结 | 有基线提交；`git status` 干净 |
| P0-1 | usage 采集（`include_usage` → 落 token 列） | 一轮对话后库里有非零 token（D3 前提） |
| P0-2 | `outcome` 三态真实化 | 人为制造一次 Key 失效，落 `error` |
| P0-3 | `agent_spans` + 写入/保留/脱敏规则 + 步级视图 | 一轮对话可见每步入参/出参/耗时/tokens（D8 关闭） |
| P0-4 | evals 骨架 + E1–E7 + `npm run eval` | 改一条 prompt 词能看出变好/变坏（D5 关闭） |
| P0-5 | 冒烟 `npm test` + `npm run eval` | 两者绿并留档 |
| P1 | `budget/assemble` 双 API + 三处注入点收口 + 召回 query 语义 | D1/D2/D4 关闭；实测 token 误差 ≤20% |
| P2 | 滚动摘要；并行工具（可选，先声明 `sideEffect`） | D6 关闭（若做） |
| P3 | Skills（不含工具清单） | D7 关闭 |

> P0-0 的理由来自目标态自己：它要求"灰度可回退 / 改前改后对比"，这需要版本控制作为载体。

---

## F. 风险表增补（并入 md §9）

| 风险 | 对策 |
|---|---|
| trace 是目标态新建的数据面，却无治理规则 | 写入/保留/脱敏三条写进目标态（D8）；上云前补鉴权与租户隔离 |
| 目标态的"可回退"缺载体 | 版本控制先行；eval 结果落盘可比对；缺 Key 如实 SKIP，不假绿 |
| 并行工具致 `tool_call_id` 错配 | 按 id 回填 `messages`；`Tool.sideEffect` 未声明不并行 |
| 预算系数无实测依据 | 用 P0-1 的 usage 校准，误差 >20% 触发回归 |

---

## G. 验证方式

```bash
npm test
npm run eval                                  # 新增；结果存 evals/report.json，与基线 diff
npm run eval -- --layer=L1 --compare=evals/baseline/report.json   # P1 之后
npm run test:live                             # 需 Key，可选
```

**P1 判据**：`assembleContext()` 是唯一上下文出口（grep 无第二处构造 `messages`）；实测 token 与预估误差 ≤20%；E5/E6 通过且兜底率不上升。

---

## H. 目标态中保留不动的判断

1. trace **只读**、禁止回灌上下文（自我污染红线）。
2. evals **不用 LLM 打分**，用可复现规则。
3. 上下文**单一出口**的强约束（本次是把它补齐，不是放松）。
4. L4 先于大改、P0 先建安全网的顺序。
5. Skills 排在上下文引擎之后的取舍（组织性收益，不解决"聊得久"）。
6. 四层记忆划分与"运行轨迹不进上下文"。

---

## I. 附录：起跑线校验（`已落地` 标注是否真实）

> 本节**不是**对目标态的结论，只确认目标态假设的既有能力是否存在。
> 凡 ⚠ 项：若目标态不把它们写进 P0/P1，目标态的验收条件（"可回退""预算可校准""质量可比对"）不成立。

| # | 目标态假设的既有能力 | 核对 | 依据 |
|---|---|---|---|
| I1 | L0 骨架（迭代上限 / 流式 / 严格回写 / 收敛判据 / 人在环） | ✅ 一致 | `server/agent.ts:22`、`server/llm/bailian.ts:380,383-392,405-427` |
| I2 | 记忆"最近 12 条 / 截 160"；历史"12 轮 / 6000 字符" | ✅ 一致 | `server/agent.ts:58-72`、`server/llm/bailian.ts:261-288` |
| I3 | 四层记忆表；13 个工具；execTool timeout+retry | ✅ 一致 | `server/db/core.ts:44-101,233-277`、`server/tools/registry.ts:66-435,473-514` |
| I4 | "180s 总超时" | ⚠ 实为 4 层：route 120s / 前端 150s / 循环 180s / 工具 15s×3（前端看门狗非 6s） | `server/routes/chat.ts:17`、`src/hooks/useServiceChat.ts:33`、`server/llm/bailian.ts:354`、`server/tools/registry.ts:507` |
| I5 | token 计量 | ⚠ `agent_runs` 无 token 列，全链路不解析 `usage` → D3 数据源需从零建 | `server/db/core.ts:92-101`、`server/llm/bailian.ts:109-182` |
| I6 | `agent_runs.outcome` 可用于质量口径 | ⚠ 恒为 `'handled'`（兜底/出错同值） | `server/llm/bailian.ts:346`、`server/agent.ts:169` |
| I7 | L0 无需改动 | ⚠ 两处建议随 L1 修：`fullText` 跨轮重复回写；工具结果无长度上限 | `server/llm/bailian.ts:386`、`server/llm/bailian.ts:430` |
| I8 | 治理面板可承载 trace | ✅ 已有**轮级**活动流 → 目标态新增的是**步级** | `src/components/GovernanceLayer.tsx:215-224`、`server/routes/admin.ts:137` |
| I9 | 记忆去重可"复用 normKey" | ⚠ `normKey` 只在前端；服务端 `saveMemory` 为精确 key 覆盖 → 需新写服务端归一 | `src/components/dashboard/shared.ts:50`、`server/db/memories.ts:24-26` |
| I10 | 上下文注入点 | ⚠ 存在产物注入旁路（直拼 user 消息）→ D1 的收口对象 | `server/llm/bailian.ts:295-306,358` |
| I11 | "可回退 / 灰度对比"的载体 | ⚠ 无版本控制、无 CI；`npm test` = 7 个探针脚本串联 | 目录实测、`package.json:12` |

---

## J. 文档自洽（与代码无关）

`ARCHITECTURE-v3.md` §2 分层图写作 **L4 = Evals & Trace、L3 = Skills**，而 §5/§6 标题写作 "L3 · Evals 与 Trace"、"L4 · Skills" —— 互相冲突。
v3.2 取 §2 图口径（L4 = Evals&Trace），建议同步修正 §5/§6 标题，避免实现者按标题挂错目录。

---

## K. HTML 呈现层同步修订（`architecture-v3.2.html` 已实施）

| 项 | v3 | v3.2 |
|---|---|---|
| 叙事框架 | 现状 + 待建混排，读者易把"现状标注"当结论 | 明示"审目标态"；起跑线校验独立成附录，注明不构成结论 |
| 结论结构 | "修订 8 条"（含现状纠偏） | "目标态 8 处设计问题 D1–D8"（按严重度分级）+ 文档自洽 1 条 |
| `--muted-2` 对比度 | `#6b7f9f`（约 4.2:1，低于 AA） | `#7d90ad`（约 5.2:1） |
| `font-family` | `ui.monospace`（字体回退） | `ui-monospace` |
| `.sse/.evo/.lbl/.er/.next` | 有类无样式 | 已补类定义 |
| 路线图 | 只有阶段与动作 | 每阶段带"完成判据"，并把 D1–D8 的关闭点标到对应阶段 |

---

*v3.1 的 `architecture-v3.1.html` 与 `ARCHITECTURE-v3.1-addendum.md` 已被本版取代（口径不同：v3.1 以"现状核对"为框架）。如需保留可自行归档。*
