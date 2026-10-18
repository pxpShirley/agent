# 星澜 · Agent 化改造架构与方案

> 参照 WorkBuddy Agent 架构，将"星澜"从「检索增强 FAQ 机器人」重构为「Agent 范式的生活管家」。
> 本文先给架构与方案，确认后再动手（Phase 0/1 起）。

---

## 0. 现状诊断：为什么必须改

当前星澜大脑本质是**检索增强 FAQ 机器人**，与"全能管家"定位矛盾：

| 位置 | 现状 | 问题 |
|---|---|---|
| `server/nlu.ts` | `classifyIntent`（关键词打分）+ `searchFaqs`（bigram 检索）+ `FAQ_SEED`（27 条写死答案） | 答非所问就失败；无法记忆、无法主动、无法执行 |
| `server/index.ts` 的 `query()` | `canUseTool` 直接 `deny` **所有工具**，system prompt 把"知识库"硬塞给模型 | 大模型只是「知识库朗读器」，不是管家 |
| `buildFallbackReply` | 无 SDK 凭证时纯知识库直答 | 与 agent 范式无关，仅是兜底 |
| `src/utils/butler.ts` | 主动卡片按时间硬编码（晚上/周一/周五/周末） | 不是"管家在想"，是 if-else 堆出来的"伪主动" |

WorkBuddy 的 agent 架构核心是：**模型自主决策 + 工具循环 + 分层记忆 + 可插拔能力（技能/连接/专家）+ 主动调度 + 人在环治理 + 可观测**。我们按这套范式重构，SDK 已具备全部原语：

- `query()` —— agent 主循环（AsyncGenerator，逐 token 流式）
- `createSdkMcpServer` + `tool()` —— 进程内自定义工具（给管家真实能力）
- `options.agents` —— 子代理委托（复杂任务分解）
- `options.tools:[]` / `canUseTool` —— 权限围栏（关掉危险内置工具，只放我们的）
- `options.systemPrompt` / `resume` / `includePartialMessages` —— 人格、会话续接、流式渲染

---

## 1. 目标架构（分层）

```
Layer 0  接入层      SSE /api/chat  → 编排器（不再拼知识库）
Layer 1  Agent 大脑  agent.ts 封装 query()：人格 prompt + 工具注入 + 流式 + 续接 + 超时/降级
Layer 2  工具箱      进程内 MCP server（recall/save_memory, reminder, schedule, web_lookup, mood, ticket, ask_user）
Layer 3  记忆层      memories(跨会话画像) · sessions/messages(短期) · reminders/moods(结构化)
Layer 4  能力(技能)   skills 注册表 —— 8 项能力真实化（出行/日程/放松/健康/学习/聊天/省钱/写作）
Layer 5  连接/专家   外部适配器（天气/日历/理财/健康）—— 先 stub，留干净接缝
Layer 6  主动调度    scheduler 触发 agent 主动任务（晨报 / 周复盘 / 提醒到期）
Layer 7  治理与人环  autonomy 级别 · 敏感动作 ask_user 确认 · 转人工=override 日志 · agent_runs 可观测
```

**关键设计点**
- `agent.ts` 用 `query({ options: { tools: [], mcpServers: { xinglan: server }, permissionMode: 'dontAsk', systemPrompt, maxTurns, effort, includePartialMessages } })`。
  - `tools: []` 关闭内置文件/Bash 工具（安全）；MCP 工具不受影响，管家**只能用我们定义的工具**。
  - `permissionMode: 'dontAsk'`：工具安全、可自动执行；只有敏感/不可逆动作在工具内部调用 `ask_user` 向用户确认。
- 会话续接：`session.sdk_session_id` 复用 SDK 会话，记忆与上下文跨轮保留。
- 运行时抽象：定义 `AgentRuntime` 接口（当前实现 = CodeBuddy SDK；可替换为本地模型直连），避免与具体供应商绑定。

---

## 2. Agent Loop（一次对话的时序）

```
用户消息
  │
  ▼
[编排器] 载入记忆(memories) + 短期上下文(messages) → 构造 systemPrompt
  │
  ▼
[query()] 模型自主决策
  ├─ 需要事实?   → 调 web_lookup / recall_memory
  ├─ 需要记录?   → 调 save_memory / checkin_mood
  ├─ 需要执行?   → 调 set_reminder / get_schedule
  ├─ 不确定/需澄清? → 调 ask_user（人在环确认）
  ├─ 高风险/超能力? → 调 create_ticket（转真人顾问，记 override）
  └─ 直接回答  → 流式文本回用户
  │  （工具调用可多轮，直到模型认为任务完成）
  ▼
[收尾] 写回记忆 + 写 agent_runs(工具序列/意图/结果) + SSE done
```

---

## 3. 功能取舍矩阵（现有 → 目标）

| 现有功能 | 判定 | 改造方式 |
|---|---|---|
| 知识库直答 `searchFaqs`+`FAQ_SEED` | **砍** | 降级为可选冷启动语料，不再是大脑。答案由模型+工具生成 |
| 关键词意图 `classifyIntent` | **砍** | 由模型在 agent loop 自主判断意图，不再前置打分 |
| 转人工 `decideEscalation` | **重构** | 改为 `create_ticket` 工具 + 人在环 override 日志 |
| 聊天/SSE 流式 | **保留** | 改为 agent 流式，前端 UI 不变 |
| 用户画像 `getPortrait` | **升级** | 由 `memories` 表驱动，跨会话真实累积，非硬 SQL 聚合 |
| ButlerHome 主动卡片 | **升级** | 由 planner（主动调度）驱动，非时间 if-else |
| 后台统计 | **重载** | 由"FAQ 命中率"转向"agent 决策质量"遥测（agent_runs） |
| 指令框 `parseCommand` | **保留** | 升级为可触发 agent 动作的命令（含批量标记等） |
| FAQ 管理页 | **替换** | 改为「记忆治理」页（查看/编辑用户记忆 + 复盘 agent 决策） |

---

## 4. 分阶段方案

### Phase 0 · 基座（不碰 UI）
- 新增 DB 表：`memories`(user/scope/key/value)、`reminders`、`moods`、`agent_runs`、`overrides`。
- 新增 `server/agent.ts`：封装 `query()`、会话续接、SSE 流式、超时保护与降级（降级仍用现有 `nlu` 但标注 deprecated）。
- 新增 `server/tools/`：进程内 MCP server，先实现**只读安全 stub** 工具（`recall_memory`/`web_lookup`/`checkin_mood`）。
- 新增 `server/skills.ts`：能力注册表骨架。

### Phase 1 · 换脑（UI 不变）
- `/api/chat` 改为走 `agent.ts`；system prompt = 管家人格 + 记忆约定 + 工具说明。
- `FAQ_SEED` 降级为可选冷启动语料（不再必需）。
- 构建 + 冒烟测试，前端聊天表现不变。

### Phase 2 · 记忆层
- `recall_memory`/`save_memory` 真实化（落 `memories`）。
- ButlerHome「了解你」chips 与 Portrait 页由真实记忆驱动；`getMemoryChips()` → 读记忆。

### Phase 3 · 工具箱
- `set_reminder`/`get_schedule`/`web_lookup`/`checkin_mood` 落地 + 持久化。
- 主动卡片（晚/周一/周五/周末）改由 planner 工具生成，而非硬编码。

### Phase 4 · 主动调度
- 轻量 scheduler（`setInterval`/定时器）触发 agent 主动任务：晨报、周复盘、提醒到期触发。
- 后台新增「主动管家」视图：展示定时任务与已触发结果。

### Phase 5 · 治理与运营
- autonomy 配置（全自动 / 半自动 / 仅建议）。
- 敏感/不可逆动作经 `ask_user` 确认；`overrides` 记录人工介入。
- 记忆治理页（替 FAQ 管理）；agent 遥测（替旧统计）；`connectors/` 留外部 API 接缝。

---

## 5. 关键决策与风险

1. **SDK 依赖**：`query()` 走 CodeBuddy CLI/端点，需凭证。用 `AgentRuntime` 抽象，可换本地模型直连（OpenAI/Claude tool-use）。
2. **安全围栏**：`tools:[]` 关内置危险工具；敏感动作 `ask_user`；不可逆动作留 `overrides` 日志。
3. **成本与可观测**：每次运行写 `agent_runs`（工具序列/意图/结果/耗时），运营大脑从"FAQ 命中率"转向"agent 决策质量"。
4. **降级**：未配 SDK 时回退确定性 butler（现有 `nlu`），标注 deprecated，保证演示不中断。

---

## 6. 需要你拍板的点

1. **Agent 运行时**：用 CodeBuddy SDK（需登录/凭证）还是接本地模型直连？
2. **主动性默认级别**：半自动（建议 + 轻执行）还是全自动？
3. **外部连接**（天气/日历/理财/健康）：先做 stub 还是现在就接真实 API？
4. 是否现在就进入 **Phase 0/1** 动手？
