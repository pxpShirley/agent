# 星澜（Xinglan）智能服务体 · 系统架构分析、迭代路径与下一阶段优先级

> 分析对象：`smart-service-agent`（前端 React 18 + Vite 5 + TypeScript；后端 Express + better-sqlite3 + 多引擎 Agent 运行时）
> 分析目的：摸清现状 → 评估各模块迭代路径 → 明确下一阶段功能演进优先级 → 为 PRD 立项提供依据
> 角色：产品经理（产品通）视角，结论可直接进入研发评审

---

## 0. 一句话结论

星澜当前已具备一个**结构完整、双引擎可演示**的"生活管家"原型：对话内核、人在环确认、主动调度、命令面板、灵境仪表盘、治理后台、指挥舱遥测均已上线。其最大资产是**"主动服务 + 人在环"双纪律设计**；最大短板是**主动开口能力被三套并行实现割裂**（确定性 2×2 简报 / 单张浮层调度卡 / 已弃用的 `getProactiveCards`），导致"管家先开口"这一核心卖点既不完整、也不可运营。

**下一阶段第一优先级 = 主动开口融合（Proactive Surface Convergence）**：把分散的主动能力收敛为一个连贯、可运营、带"需要你"闭环的主页开口面，并清除技术债。详见配套 PRD。

---

## 1. 整体架构

```
┌──────────────────────────── 前端（React / Vite） ────────────────────────────┐
│  App → CustomerPage → XinglanShell（IA 收敛后：主页/灵境/治理 + 历史抽屉浮层） │
│   ├─ 主页空态：getDailyBrief() 2×2 简报 + 能力 chips + ⌘K 命令面板             │
│   ├─ 灵境 DashboardPanel：记忆 / 目标 / 产物（3 Tab，真实数据）               │
│   ├─ 治理 GovernanceLayer：运行设置 + 后台鉴权                                │
│   └─ useServiceChat：SSE 流式 / 本地兜底 / proactive / 人在环 confirm          │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                     │  /api/*（vite 代理 → :3000）
┌───────────────────────────────────▼─────────────────────────────────────────┐
│  后端（Express + better-sqlite3，单文件 data/chat.db，WAL）                    │
│   ├─ 对话内核 /api/chat（SSE）：选路 演示→百炼→CodeBuddy SDK，失败自动回退     │
│   ├─ 人在环 /api/chat/confirm：approve/escalate/defer/cancel → relayOutbound │
│   ├─ 主动调度 scheduler：晨报/周复盘/到期提醒 → proactive_cards 表             │
│   ├─ 记忆层：memories / reminders / moods / agent_runs / pending_questions    │
│   └─ 指挥舱 /api/admin/*：统计/画像/会话/记忆治理/活动流/例外收件箱/实时流      │
└────────────────────────────────────────────────────────────────────────────┘
```

**分层职责**
- **接入层**：SSE `/api/chat` 统一事件协议（`init/text/tool/tool_result/ask_user/artifact/done/notice`）。
- **Agent 大脑**：`agent.ts`（SDK）/ `llm/bailian.ts`（通义千问）/ `llm/orchestrator.ts`（Planner→Researcher→Executor→Critic 多智能体）。`MULTI_AGENT=0` 可关编排。
- **工具箱**：进程内 MCP 风格的 `set_reminder / recall_memory / web_lookup / mood / ask_user / create_ticket` 等（详见 `server/tools`、`server/agent.ts`）。
- **记忆层**：跨会话 `memories`，短期 `sessions/messages`，结构化 `reminders/moods`，遥测 `agent_runs`，人在环 `pending_questions`，主动 `proactive_cards`，产物 `artifacts`。
- **主动调度**：`scheduler.ts` 每分钟 tick，产出主动卡片（agent 生成需 `AGENT_BRIEFING=1` + SDK，否则模板）。
- **治理**：`/api/chat/confirm` 的 `ask_user` 闭环 + `overrides` 日志；后台 `ADMIN_TOKEN` 可选鉴权。

---

## 2. 技术栈

| 层 | 选型 | 版本/说明 |
|---|---|---|
| 前端框架 | React + TypeScript + Vite | 18 / 5，HMR + 代理 `/api→:3000` |
| UI 组件 | TDesign React（含 `@tdesign-react/chat`、`@tdesign-react/aigc`）+ lucide-react | 对话/产物组件 + 图标 |
| 路由 | react-router-dom | v7 |
| 样式 | 自研深空玻璃设计系统（xinglan.css / XinglanShell.css / nebula.css）+ Tailwind + Less | 双色令牌（冰青系统语 / 暖金人在环） |
| 后端 | Express | v4，`PORT=3000` |
| 持久化 | better-sqlite3 | 单文件 `data/chat.db`，WAL，自动建表 + 轻量迁移 |
| Agent 引擎 | `@tencent-ai/agent-sdk` + 百炼/通义千问（`llm/bailian.ts`）+ 多智能体编排 | 三引擎热切换，失败回退 mock |
| 出站 | nodemailer + Webhook（`actions/outbound.ts`） | 人在环批准后的真实执行通道 |
| 工具 | uuid | ID 生成 |

> **关键事实**：所有客户侧数据以 `owner='guest'` 归一（单用户演示）；客户侧无鉴权；后台 `ADMIN_TOKEN` 未设则全开放。这是演示态设定，也是规模化的关键约束（见 §5 风险）。

---

## 3. 已上线功能的设计逻辑与实现方式

| # | 功能 | 设计逻辑 | 实现方式（关键文件） |
|---|---|---|---|
| F1 | 对话内核（流式） | 模型自主决策 + 工具循环；前端只负责渲染 | `useServiceChat.send` 消费 SSE；`server/index.ts` `/api/chat` 选路三引擎；本地兜底 `runLocalMock` 保证离线也有反应 |
| F2 | 意图识别 | 仅用于归档/统计，**不再驱动作答** | `server/nlu.ts classifyIntent` 打标 → `sessions.intent`；模型在 agent loop 内自主判断 |
| F3 | 人在环（HITL） | 高风险/不可逆动作前 `ask_user` 确认；4 决策闭环 | `ask_user` 事件 → `pending_questions` 表 → `/api/chat/confirm`（approve/escalate/defer/cancel）→ `relayOutbound` 真实发送；前端 `ConfirmCard` + 金条"需要你" |
| F4 | 每日简报（2×2） | 主页空态"管家先开口"；确定性、零依赖后端 | `butler.getDailyBrief(ctx)` 派生 goal/need/memory/tip 四行；`need` 行 `human:true` → 暖金；点击 `dispatch(action)` |
| F5 | 主动调度 | 后台"不用你开口"也办事 | `scheduler.ts` 每分钟 tick → `proactive_cards`（morning/weekly/reminder_due）；agent 生成需 `AGENT_BRIEFING=1` |
| F6 | 单张浮层主动卡 | 把调度卡暴露给用户 | `CustomerPage` 取 `chat.proactive[0]` → `XinglanShell` 浮层"交给我/稍后"（markSeen/dismiss） |
| F7 | ⌘K 命令面板 | 能力/记忆/历史统一检索入口 | `CommandPalette.tsx`：跨 `CAPABILITIES`+记忆+会话检索 → `dispatch`；遮罩/Esc 关闭 |
| F8 | 历史抽屉 | 低频功能降级为浮层，不占主面 | `XinglanShell` `histOpen` + `SessionList`；Rail"历史"按钮开启，遮罩/Esc 关闭 |
| F9 | 灵境仪表盘 | 记忆/目标/产物内联面板 | `DashboardPanel.tsx` 3 Tab，读 `/api/context` + `/api/artifacts`；目标进度条用暖金 |
| F10 | 治理 / 运行设置 | 自助配凭证 / 演示模式 / 模型 | `GovernanceLayer.tsx` + `/api/settings`；`ADMIN_TOKEN` 可选 |
| F11 | 指挥舱（后台） | 运营大脑：决策质量遥测 | `/api/admin/*`：stats/portrait/conversations/记忆治理/runs（活动流）/pending（例外收件箱）/stream（实时） |
| F12 | 双色 + 零弹窗纪律 | 冰青=系统语，暖金=仅人在环；所有反馈内联 | CSS 令牌 + `butler.BriefRow.human`；浮层均 mask/Esc 关闭，无 `dialog` |

**值得肯定的设计纪律**：F3/F12 把"人的环"严格限制在暖金面（需要你、进行中目标进度），系统语一律冰青——这是差异化的视觉锚点，迭代中必须守住。

---

## 4. 各模块迭代路径与优化方向

> 评估维度：产品价值（是否服务"主动+人在环"北极星）、工程现实（可行性/成本）、技术债（是否阻碍下一步）。优先级建议：P0=立即做 / P1=本季度 / P2=更晚或依赖前置。

### 4.1 主动开口能力（F4/F5/F6 + 弃用 F0）
- **现状**：2×2 简报（确定性，不吃调度卡）、单张浮层卡（`proactive[0]`，漏掉其余调度卡）、`getProactiveCards`（旧引擎，**已零引用、纯死代码**）。三套并存、互不同步；"需要你"金条只跳转不闭环。
- **路径**：收敛为**单一主页开口面**——调度卡（含晨报/周复盘情感语气）与上下文简报融合；"需要你"升级为可操作闭环（处理/稍后/转交）；删除死代码。
- **价值**：直接兑现核心卖点，消除 3 处技术债。**优先级 P0（本次 PRD 立项）。**

### 4.2 人在环闭环（F3）
- **现状**：`ask_user`→confirm→outbound 链路完整，4 决策齐备；出站依赖 SMTP/Webhook 配置。
- **路径**：① 把"需要你"从对话内 ConfirmCard 延伸到主页开口面（与 4.1 同源）；② 出站通道可视化状态（已配/未配）；③ 批量/定时确认的"自动驾驶"模式（autonomy 分级）。
- **价值**：北极星第二支柱。**优先级 P0/P1（与 4.1 同一特性包）。**

### 4.3 对话内核与多引擎（F1/F2）
- **现状**：三引擎热切换 + 自动回退，演示稳定；意图仅归档。
- **路径**：① 接通真实外部工具（天气/日历/理财 stub→真实 API）；② 降低 mock 回退对质量问题的掩盖（加"降级中"显式标识 + 遥测）；③ 长会话记忆压缩。
- **价值**：让"办事"从骨架变真实。**优先级 P1。**

### 4.4 ⌘K 命令面板（F7）
- **现状**：能力/记忆/历史检索 + dispatch；骨架可用。
- **路径**：① 自然语言 → 意图直达（输入框直接发）；② 主动建议常驻（结合 4.1 的开口面）；③ 结果可预览（不必先 dispatch）。
- **价值**：入口效率。**优先级 P1（轻量）。**

### 4.5 灵境仪表盘（F9）
- **现状**：3 Tab，真实数据，空态引导好。
- **路径**：① 记忆编辑/删除（当前只读）；② 目标与提醒双向同步（仪表盘改 → 调度/简报变）；③ 情绪趋势可视化。
- **价值**：让"被记住"可管理。**优先级 P1。**

### 4.6 历史抽屉（F8）
- **现状**：抽屉可用，Rail 红点提示。
- **路径**：① 搜索/筛选；② 会话续接体验（含上下文延续）；③ 导出。
- **价值**：低频但影响复用。**优先级 P2。**

### 4.7 治理与运行设置（F10）
- **现状**：凭证/演示/模型可自助；后台可选鉴权。
- **路径**：① 真实多租户 owner 体系；② 默认开启后台鉴权 + 操作审计；③ autonomy 分级 UI。
- **价值**：从演示走向可部署。**优先级 P1（安全前置）。**

### 4.8 指挥舱（F11）
- **现状**：统计/画像/记忆治理/活动流/例外收件箱/实时流齐全。
- **路径**：① 指标从"FAQ 命中率"转"agent 决策质量"（已埋 `agent_runs`，需可视化）；② 例外收件箱与主页"需要你"同源；③ 告警（逾期待办堆积、情绪走低自动提醒运营）。
- **价值**：让运营可观测、可干预。**优先级 P1/P2。**

### 4.9 设计系统（F12）
- **现状**：双色 + 零弹窗纪律清晰，但令牌层多（xinglan.css/XinglanShell.css/nebula.css + tailwind）。
- **路径**：① 统一为单一令牌源；② 沉淀为组件库（chip/卡片/浮层复用）；③ 暗/亮主题令牌补全。
- **价值**：规模化前置。**优先级 P2（但 4.1 需先冻结"需要你/系统语"语义）。**

### 4.10 数据源与持久化
- **现状**：SQLite 单文件，单用户 `guest`，无客户侧鉴权。
- **路径**：① 多租户 owner（与 4.7 同源）；② 备份/迁移策略；③ 评估是否换 Postgres（规模化时）。
- **价值**：可部署前提。**优先级 P1（与 4.7 绑定）。**

---

## 5. 下一阶段演进优先级（Now / Next / Later）

### Now（未来 1–2 个迭代，立即可做）
1. **P0 — 主动开口融合 + 需要你闭环升级**（配套 PRD）：收敛 2×2 简报、单张浮层卡、死代码为单一主页开口面；"需要你"从跳转变闭环。
2. **P0 — 后台鉴权默认开启 + 操作审计**：消除"全开放"风险（配合多租户前的过渡）。
3. **P1 — 仪表盘记忆可编辑 + 目标双向同步**：让"被记住"可管理，呼应主动开口。

### Next（本季度）
4. **P1 — 外部工具真实化**（天气/日历/理财 stub→API）：让"办事"成真。
5. **P1 — 多租户 owner 体系 + 数据源可部署**：从演示走向上线。
6. **P1 — 指挥舱"决策质量"可视化**：用 `agent_runs` 替代旧统计叙事。
7. **P1 — ⌘K 自然语言直达 + 主动建议常驻**。

### Later（更晚 / 依赖前置）
8. **P2 — autonomy 分级（全自动/半自动/仅建议）** UI 与策略。
9. **P2 — 历史会话搜索/续接/导出**。
10. **P2 — 设计系统单一令牌源 + 组件库沉淀**。
11. **P2 — 规模化数据层评估（Postgres / 备份）**。

> **立项建议**：`Now-1` 是投入产出比最高、且能同时清掉三处技术债的单项，作为下一阶段第一交付物。下一节 PRD 即围绕它展开。

---

## 6. 关键风险与约束（PRD 必须正视）

1. **单用户/无客户鉴权**：当前 `owner` 恒为 `guest`，PRD 的"个性化主动"只能基于单人上下文；多租户前不要承诺跨用户个性化。
2. **主动卡与简报双源不同步**：调度卡（情感语气）未被简报消费，融合时需定义"单一可信源"（建议：后端 `proactive_cards` 为权威源，前端 `getDailyBrief` 退居"无卡时的确定性兜底"）。
3. **引擎回退掩盖质量**：mock 自动兜底会让真实引擎失败"看起来正常"，需显式"降级中"标识，避免误判主动能力效果。
4. **出站通道依赖配置**：人在环"批准即发"需 SMTP/Webhook；未配置时应优雅降级（本地记录 + 提示配置），不能静默失败。
5. **双色纪律不可破**：任何新增主动面必须守住"暖金=仅人在环"，PRD 验收要包含视觉纪律检查。
6. **死代码治理**：`getProactiveCards` 删除前确认其视觉语义（"洞察"角标）是否被新开口面吸收，避免能力倒退。

---

## 7. 与配套 PRD 的衔接

- 本文 §3(F4/F5/F6)、§4.1、§6(2)(5)(6) 直接构成 PRD 的"现状与缺口""背景与目标""约束"。
- 本文 §5 的 Now/Next/Later 是 PRD 之外更广的路线图；PRD 只深做 Now-1。
- PRD 文件：`PRD-proactive-surface-convergence.md`（结构完整、含背景/场景/详述/边界/验收/依赖，可直接研发评审与排期）。
