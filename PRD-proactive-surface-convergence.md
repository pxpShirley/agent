# 产品规格文档（PRD）：星澜·主动开口融合与「需要你」闭环升级

| 项 | 内容 |
|---|---|
| 文档状态 | 评审稿 v1.0 |
| 作者 | 产品通（Product Management Expert） |
| 创建日期 | 2026-08-19 |
| 关联分析 | `doc-architecture-analysis.md`（系统架构、迭代路径与优先级） |
| 关联代码 | `src/utils/butler.ts`、`src/components/XinglanShell.tsx`、`server/scheduler.ts`、`src/hooks/useServiceChat.ts`、`src/api.ts`、`server/index.ts`、`server/db.ts` |
| 所属路线图 | Now-1（下一阶段第一交付物，P0） |
| 评审结论 | 待研发/设计/数据评审 |

---

## 1. 功能背景与目标

### 1.1 背景（Why）
星澜的定位是"主动服务的生活管家"，差异化在于**「主动开口」+「人在环」**双纪律。但现状分析（`doc-architecture-analysis.md` §3/§4.1）发现，主动开口能力被**三套并行实现割裂**：

1. **2×2 每日简报**（`butler.getDailyBrief`）：确定性、纯前端，**不消费**后端调度器的晨报/周复盘富内容。
2. **单张浮层主动卡**（`CustomerPage` 取 `chat.proactive[0]`）：后端 `scheduler` 产出的 `proactive_cards` 只露一张，其余被隐藏；且仅有"交给我/稍后"两个动作。
3. **`getProactiveCards`（旧引擎）**：已**零引用、纯死代码**，其"洞察"角标语义未迁移。

同时，"需要你"（暖金、人在环唯一允许面）目前只是简报里一行带"交给我→"的链接 + 主页一条点击跳转的金条，**未形成可操作闭环**：用户无法在开口面就地"处理/稍后/转交"，也不与 `pending_questions` 确认流连通。

**代价**：核心卖点不完整、不可运营；三处技术债持续增加收敛成本；用户感知不到"管家真的在替我盯着"。

### 1.2 目标（How we know it succeeded）
- **用户目标**
  - G1：用户打开主页即看到"管家替我盯的事"——且晨报/周复盘/到期提醒/待确认**同面聚合、不遗漏**。
  - G2：凡是需要我拍板的事（到期提醒、待确认动作），在主页开口面就能**就地闭环**（处理/稍后/忽略），不必跳转。
  - G3：主动内容**个性化且即时**（基于真实记忆/待办/情绪），而非固定时间 if-else。
- **业务目标**
  - G4：主动开口面的**日触达率**（打开主页即见）≥ 80%，且点击/处理率 ≥ 30%（上线 30 天）。
  - G5：清除 `getProactiveCards` 死代码及"简报/浮层卡"双源不同步，主动面**单一可信源**落地。
  - G6：守住双色纪律（暖金=仅人在环），新增主动面零破坏。

> 目标可衡量：G4/G5 由现有 `agent_runs` + 新增开口面曝光/点击埋点支撑；G6 由视觉纪律检查（PRD §6.4）保障。

---

## 2. 用户场景

**人物**：小澜（演示 owner=`guest`，都市独居青年，把星澜当"生活搭子"）。

- **场景 A · 早晨开口**：小澜 8 点打开主页。开口面顶部是"今日晨报"（基于记忆"习惯晚上 11 点后少打扰"+ 待办"交水电费已逾期"），其中"交水电费"因逾期被标为**暖金"需要你"**，提供「现在处理 / 稍后 / 忽略」。小澜点"现在处理"→ 直接发起对话让管家代办。
- **场景 B · 待确认闭环**：昨天小管家在对话里发起一条"帮你订阅周报"的 `ask_user`，小澜没当场回。今天主页开口面出现该**待确认项**（暖金），选项「批准 / 转人工 / 稍后 / 取消」就地展开，不必回翻旧会话。
- **场景 C · 周复盘温柔回顾**：周五晚，开口面出现"本周复盘"（基于本周记忆与待办生成、带情感语气），非告警式，点击可展开全文或"聊两句"。
- **场景 D · 空上下文兜底**：新用户无任何记忆/待办。开口面由确定性 `getDailyBrief` 兜底，呈现"今天想推进哪件要紧事？"等引导，不空白、不报错。
- **场景 E · 边缘：无后端**：后端未起（演示模式）。开口面仍以本地上下文兜底渲染，离线提示优雅，不崩溃。

---

## 3. 功能详细描述

### 3.1 核心概念
- **开口面（Opening Surface）**：主页空态下"管家先开口"的聚合区域，是 2×2 简报的升级形态——从"固定四格"变为"按优先级排布、可含多种类型"的列表/网格混合。
- **单一可信源**：后端 `proactive_cards`（调度器产出：morning/weekly/reminder_due）+ `pending_questions`（人在环）+ 实时 `AgentContext`（memories/reminders/moods）。前端 `getDailyBrief` **降级为兜底**（无卡/无后端时确定性呈现）。
- **需要你（Human-in-the-loop）**：开口面中 `human:true` 的项，**唯一允许暖金**，且必须提供可操作动作。

### 3.2 信息架构（开口面内部结构）
```
开口面（主页空态）
├─ 优先区：需要你（暖金，可折叠）
│   ├─ 待确认项（pending_questions）：批准 / 转人工 / 稍后 / 取消
│   └─ 到期/24h 内提醒（reminder_due）：现在处理 / 稍后 / 忽略
├─ 关怀区（冰青）
│   ├─ 今日晨报 / 本周复盘（proactive_cards：morning/weekly）
│   ├─ 记忆关怀（context.memories[0]）
│   └─ 今日建议（时间启发）
└─ 能力入口（冰青）：能力 chips + ⌘K 常驻
```
> 布局原则：需要你恒在最上且暖金；其余按"时间相关度"排序；空上下文时仅渲染关怀区兜底 + 能力入口。

### 3.3 子功能详述

**SF-1 开口面数据聚合（`getHomeOpening`）**
- 新增 `butler.getHomeOpening(ctx, cards, pending)`：输入 `AgentContext`、`proactive_cards[]`、`pending_questions[]`，输出**去重、排序、带类型与动作**的开口项数组。
- 排序：需要你（逾期>24h>待确认）> 晨报/周复盘 > 记忆/建议。
- 去重：同一 `ref_id`（如 reminder 既在简报 need 又在 scheduler reminder_due）只留一条，以"需要你"优先。

**SF-2 需要你 · 就地闭环**
- 待确认项渲染 `ConfirmCard` 风格的**内联**四选项（批准/转人工/稍后/取消），调用既有 `/api/chat/confirm`（已支持 4 决策 → `relayOutbound`）。
- 到期提醒项提供「现在处理 / 稍后 / 忽略」：`现在处理`→`dispatch` 发起对话；`稍后`→ 延迟 N 小时（写回 `proactive_cards.due_at` 或 `snoozed_until`）；`忽略`→ `dismissProactiveCard`。
- 闭环后该项从开口面消失，并触发 `notifyChanged` 刷新（复用 `/api/admin/stream` 机制）。

**SF-3 调度卡富内容消费**
- 晨报/周复盘卡在开口面**完整呈现**（标题 + 正文，可展开/收起），不再只露一张浮层。
- 卡片动作：展开全文 / "和管家聊两句"（dispatch 预设语）/ 稍后（dismiss 或 snooze）。

**SF-4 确定性兜底保留**
- 当 `cards` 为空或后端不可达时，`getDailyBrief` 的 goal/need/memory/tip 四行作为兜底渲染，**保留现有双色与 action**。
- 后端恢复后无缝切换到"聚合源"渲染，UI 不闪。

**SF-5 死代码清除**
- 删除 `butler.getProactiveCards` 及其 `ProactiveCard`（butler 版）定义；确认其"洞察"角标语义由开口面的"需要你/个性化"吸收，不丢失能力。
- 统一 `ProactiveCard` 类型：以 `src/types.ts` 的 DB 镜像版为权威，前端不再自定一套。

**SF-6 零弹窗 & 双色纪律（不可破）**
- 开口面是主页内联区，非 modal；交互（展开/选项）均内联，Esc/遮罩逻辑不变。
- 暖金**仅**用于：`human:true` 的需要你项、进行中目标进度条。其余冰青。

### 3.4 关键交互流（需要你闭环）
```
用户打开主页
  → useServiceChat 已拉取 context / proactive / pending（既有）
  → getHomeOpening 聚合 → 渲染开口面
  → 用户点"需要你·待确认项"的「批准」
      → /api/chat/confirm(approve) → 后端 relayOutbound 真实发送
      → 返回 resolution → 该项从开口面移除 + 会话追加解析消息（既有）
  → 用户点"到期提醒"的「现在处理」
      → dispatch("帮我处理…") → 切主页 + 发对话（既有 runCommand）
```

---

## 4. 边界条件与约束

- **B1 单用户约束**：当前 `owner` 恒为 `guest`，个性化仅基于单人上下文；**不承诺跨用户个性化**，多租户前不扩展。
- **B2 单一可信源**：以 `proactive_cards` + `pending_questions` + 实时 `context` 为权威；`getDailyBrief` 仅兜底。任何新增主动内容须先落库再呈现，禁止前端再硬编码时间 if-else（旧 `getProactiveCards` 已证明不可维护）。
- **B3 出站依赖配置**：人在环"批准即发"需 SMTP/Webhook；**未配置时**必须优雅降级（本地记录 + 显式提示"去设置配置出站通道"），不得静默失败或假成功。
- **B4 引擎回退不掩盖质量**：真实引擎失败自动回退 mock 时，开口面的"个性化"内容可能来自模板，**需在 UI 显式标注"演示内容"**，避免误判主动能力效果（影响 G4 度量）。
- **B5 双色纪律**：暖金仅限需要你/进行中目标；新增任何开口项须过视觉纪律检查（§6.4）。
- **B6 性能**：开口面聚合须在 `context` 变更时 `useMemo` 计算，不引入额外网络往返（复用既有 `refreshContext/proactive/now`）。
- **B7 数据量**：单 owner 主动卡/待确认项通常 ≤ 10；开口面**最多渲染前 6 项**，超出折叠"查看全部"→ 历史抽屉/灵境。

---

## 5. 验收标准（Acceptance Criteria）

### P0（必须，缺一则不可上线）
- [ ] **AC1 聚合无遗漏**：给定 `proactive_cards=[morning, reminder_due]` + `pending=[1 条待确认]`，开口面同时呈现三者，且"需要你"区在最上。
- [ ] **AC2 需要你闭环**：点待确认项「批准」→ 调用 `/api/chat/confirm` 且该项从开口面移除；点「稍后」→ 该项暂时隐藏（snooze）不消失于库；点「取消」→ `status=cancelled` 不再出现。
- [ ] **AC3 到期提醒动作**：点「现在处理」→ 触发 `dispatch` 并切回主页对话；点「忽略」→ `dismissProactiveCard` 且不再出现。
- [ ] **AC4 单一源**：删除 `getProactiveCards` 后，全仓零引用；`grep -rn getProactiveCards src` 为空。
- [ ] **AC5 兜底不崩**：停掉后端，`owner=guest` 空上下文时开口面由 `getDailyBrief` 兜底渲染，无报错、无空白。
- [ ] **AC6 双色**：仅 `human:true` 项与进行中目标进度条为暖金；其余冰青（视觉纪律检查通过）。

### P1（重要，可 fast-follow）
- [ ] **AC7 调度卡富呈现**：晨报/周复盘卡正文完整可见，可展开/收起，不再只露浮层单卡。
- [ ] **AC8 演示标注**：当内容来自 mock/模板而非真实引擎，开口面相关项标注"演示内容"。
- [ ] **AC9 去重**：同一 `ref_id` 的提醒在 need 与 reminder_due 间只渲染一条（需要你优先）。

### P2（架构保险，本期不实现但设计须兼容）
- [ ] **AC10 可扩展**：`getHomeOpening` 返回结构支持未来新增开口类型（如外部连接事件）而不改渲染层。
- [ ] **AC11 埋点预留**：开口面每项带 `kind` 与 `ref_id`，便于后续曝光/点击度量（G4）。

**Given/When/Then 示例**
- Given 用户有 1 条 `pending_questions`（status=pending）
- When 用户打开主页并点该项「批准」
- Then 调用 `/api/chat/confirm(approve)`，该项从开口面移除，会话追加 resolution 消息，且若配置出站则真实发出。

---

## 6. 与其他模块的依赖关系

| 依赖模块 | 关系 | 说明 |
|---|---|---|
| `server/scheduler.ts` | 上游数据源 | 产出 `proactive_cards`（morning/weekly/reminder_due）；本特性消费之，不改变其生成逻辑（除非顺带修 `AGENT_BRIEFING` 标注）。 |
| `server/db.ts` | 数据层 | `proactive_cards`、`pending_questions`、`memories/reminders/moods` 读写；可能新增 `snoozed_until` 字段（P1 稍后）。 |
| `src/hooks/useServiceChat.ts` | 状态源 | 已暴露 `proactive[]`/`context`/`proactive` 的 seen/dismiss；需新增/复用 `confirmQuestion`（既有）对接需要你。 |
| `src/api.ts` | 接口 | 复用 `proactive`、`proactiveSeen/Dismiss`、`confirmQuestion`、`context`；无需新增客户接口（后端 confirm 已齐备）。 |
| `src/components/XinglanShell.tsx` | 宿主 | 开口面渲染容器；替换现有 `briefRows` 单源 + 单张浮层卡两处为统一 `getHomeOpening` 渲染。 |
| `src/components/ConfirmCard.tsx` | 复用 | 需要你四选项 UI 内联化参考其样式/逻辑。 |
| `src/components/CommandPalette.tsx` | 协同 | ⌘K 保持"主动建议常驻"后续迭代（Next 阶段），本期不耦合。 |
| `server/index.ts` `/api/chat/confirm` + `actions/outbound.ts` | 闭环执行 | 人在环批准后的真实出站；B3 降级依赖其配置检测。 |
| 设计系统（xinglan.css 等） | 视觉契约 | 暖金 `--gold` / 冰青 `--brand` 令牌；新增类名须 `.xl` 前缀纪律（见项目 memory）。 |

> **关键解耦点**：本特性**不改后端生成逻辑**，只改变"前端如何聚合与呈现"已存在的数据；后端 confirm 接口已完整，故后端工作量极小，主要为前端重构 + 死代码清除。

---

## 7. 非目标（Non-Goals）

- **NG1 不改调度器生成逻辑**：晨报/周复盘的"写什么"不在本期范围（仅改"怎么呈现"）。
- **NG2 不做多租户/跨用户个性化**：B1 约束，owner 仍 `guest`。
- **NG3 不新增后端接口**：confirm/context/proactive 已够用；若需 snooze 持久化，复用 `proactive_cards.due_at` 或轻量字段，不新建路由。
- **NG4 不做 autonomy 分级 UI**：属于 Later 阶段，本期只交付"需要你就地闭环"，不引入全自动模式。
- **NG5 不重构设计系统令牌层**：仅遵守既有双色纪律，单一令牌源合并留 P2。
- **NG6 不接外部真实 API**（天气/日历）：属 Next 阶段，本期主动内容仍基于本地记忆/待办/模板。

---

## 8. 成功指标

**领先指标（上线后 days–weeks）**
- L1 开口面日触达率（打开主页即见开口项）目标 ≥ 80%，基线（当前浮层单卡）≈ 低（多数用户看不到其余卡）。
- L2 需要你项点击/处理率 ≥ 30%（30 天）。
- L3 待确认项平均闭环时长（出现→处理）≤ 24h。

**滞后指标（weeks–months）**
- G1 主动开口相关的"管家先开口"正向反馈（NPS 子项）提升。
- G2 技术债清除：`getProactiveCards` 死代码归零，主动面单一源落地（G5）。

**度量方法**：复用 `agent_runs` 遥测 + 新增开口面曝光/点击埋点（AC11），窗口 30 天评估；数据侧由指挥舱 `stats` 扩展支撑。

---

## 9. 开放问题

| # | 问题 | 责任人 | 阻塞级 |
|---|---|---|---|
| Q1 | "稍后"的 snooze 时长默认多少（1h/次日/自定义）？是否需持久化字段？ | 产品+研发 | 非阻塞（P1，可先 dismiss 替代） |
| Q2 | 待确认项在开口面与对话内 ConfirmCard 同时出现时，是否去重只显一处？ | 研发+设计 | 非阻塞（建议开口面为唯一入口，对话内改为"已在开口面处理"提示） |
| Q3 | 后端未配置出站时，"批准"应显式阻断还是允许本地记录？ | 产品 | **阻塞**（影响 B3 与 AC3 语义） |
| Q4 | 演示标注（B4）的触发条件：以 `usedFallback`/mock 模式为准，还是以 `AGENT_BRIEFING` 为准？ | 研发 | 非阻塞 |
| Q5 | 开口面最多 6 项，超出时"查看全部"落到哪个既有视图（历史抽屉/灵境）？ | 设计 | 非阻塞 |

---

## 10. 排期建议（Phasing）

- **Phase A（P0，约 1 迭代）**：`getHomeOpening` 聚合 + 开口面统一渲染 + 需要你就地闭环（复用 confirm）+ 死代码清除 + 双色/兜底验收（AC1–AC6）。
- **Phase B（P1，fast-follow）**：调度卡富呈现（AC7）、演示标注（AC8）、去重（AC9）、snooze 持久化（Q1）。
- **Phase C（P2，架构保险）**：埋点（AC11）、外部事件类型扩展（AC10）。

> 依赖前置：本特性可在**不依赖任何后端改动**下完成 Phase A（仅前端重构 + 复用既有接口）。建议与"后台鉴权默认开启"（Now-2）并行，但代码解耦。

---

## 11. 附录：研发实现要点（参考锚点）

- **聚合函数**：新增 `src/utils/butler.ts → getHomeOpening(ctx, cards: ProactiveCard[], pending: PendingQuestion[]): OpeningItem[]`；`OpeningItem = { key, kind, label, title, human?, body?, actions: {label, value}[] , refId? }`。
- **渲染替换点**：`XinglanShell.tsx` 第 176 行 `briefRows = useMemo(getDailyBrief…)` 与第 318 行单张浮层卡 `{proactive && …}` 合并为统一 `opening` 渲染；`CustomerPage.tsx:258` 的 `proactive[0]` 改为传全量 `proactive` 给开口面。
- **闭环复用**：`useServiceChat.confirmQuestion(id, decision, value)` 已支持 4 决策；开口面"需要你"直接调用，无需新增 hook。
- **死代码**：删除 `butler.ts:65` `getProactiveCards` 及 `ProactiveCard`（butler 版）接口；`src/types.ts` 的 `ProactiveCard` 为权威。
- **回归**：沿用既有 Playwright 验证（空态 `seenDemo=1` 闸门），新增开口面项计数与"需要你"暖金断言。
