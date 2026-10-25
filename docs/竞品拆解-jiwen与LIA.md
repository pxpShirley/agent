# 竞品拆解：jiwen（积温）× LIA —— 给星澜的"可检视的主动"移植方案

> 目的：把两个最值得扒的开源项目拆开，看清楚它们各自解决了"主动管家"的哪个子问题，
> 再落到星澜已有的壳上——**不新增任何基础设施**。
>
> - **jiwen** 解决"**何时该主动**"（确定性状态机，替换 `server/scheduler.ts` 里硬编码的早 6 点 / 周五 18 点）。
> - **LIA** 解决"**主动的姿态**"（我提你定，映射进已有的暖金「人的环」浮层 + `ProactiveAction` 审批动作）。
> - 二者合起来 = 星澜缺失的"**可检视的主动**"能力：每一步主动都能回答"为什么是现在、为什么是这条"。

---

## 0. 一句话结论

| 项目 | 它是什么 | 给星澜的用处 | 移植成本 |
|------|----------|--------------|----------|
| **jiwen** | ~500 行零依赖 JS "积温"引擎，五轴连续漂移 + 阈值触发，决定 AI 角色**什么时候该先开口** | 把 scheduler 的"硬 cron 三件套"换成**确定性、可追踪**的主动时机模型 | 低：纯函数 + 单表，同构 `server/clarify.ts` |
| **LIA** | 150K+ 行 LangGraph 多智能体，"我提你定"哲学 + 6 层 HITL 审批 + Psyche 功效引擎 | 它的"提案→审批"姿态**星澜已有 80%**（暖金浮层 + `ProactiveAction`），只缺"提议由确定性动机驱动"这一环 | 极低：主要是哲学对齐，不是代码 |

**最大收获**：星澜不需要抄 LIA 的工程，只需要把 jiwen 的"动机引擎"塞进自己已有的"提议外壳"。

---

## 1. jiwen（积温）拆解

### 1.1 它是什么

- 仓库：`github.com/ClaraShafiq/jiwen`（npm `@clarashafiq/jiwen`，MIT，纯 JS 零依赖）
- 一句话：**不靠概率骰子决定"AI 角色什么时候先开口"**。后台持续追踪 5 个连续数值，随时间漂移，到阈值自然触发行为。
- 设计纪律（与星澜价值观一致）：
  - `tick()` **不写回复、不存数据、不调模型**——只推进状态 + 输出触发信号。剩下的（生成内容）交给宿主。
  - 数值**不直接喂 LLM**，由 `getPromptContext()` / `getStyleGuidance()` 翻译成人话再注入 prompt。
  - 每次判定可回溯：`getTriggerTrace()` 给出"哪个闸门过了 / 被哪根轴挡了 / 差多少"。

### 1.2 五轴状态（真实常量）

| 轴 | 范围 | 含义（原版，嘴硬恋人视角） | 漂移速率（默认） |
|----|------|--------------------------|------------------|
| **connection** 联结需求 | 0→1 | 多久没听到对方，想念在累积 | `connectionRateFn` 动态基础速率；前 `accelDelay` 分钟线性，之后 `pow(1+c, connectionAccel)` 加速；valence 可调制 |
| **pride** 骄傲 | -1→+1 | 端着还是放软 | 未触发防御时回归 0（0.003/min）；被冷落时防御性升至 `prideDefendTarget`(0.5) |
| **valence** 愉悦度 | -1→+1 | 好受/难受（Russell 环状模型） | 回归设定点 0（0.005/min）；connection 超 `valenceLockThreshold` 时回归减速 |
| **arousal** 唤醒度 | -1→+1 | 焦躁/兴奋 vs 平静/慵懒（正交 valence） | 回归 0（0.005/min）；connection 超 `arousalConnectionRiseThreshold` 时以 `arousalConnectionRiseRate`(0.002) 攀升 |
| **immersion** 沉浸度 | 0→1 | 正在做事的专注度，也是骄傲的缓冲垫 | 衰减 0.01/min（60 分钟归零） |

> 关键耦合（原版的"角色性格"来源）：
> - 等待拉升 arousal，同时锁定 valence 回归（想念越重，坏情绪越难散）。
> - 沉浸度衰减 → 借口会过期，不能永远躲在事后面。
> - pride 高 + connection 中 → 内心战争加热 arousal（`prideArousalConflictRate`）。

### 1.3 阈值状态机（真实代码）

默认阈值：`observation 0.20` / `considerContact 0.35` / `forceContact 0.50` / `prideBlock 0.50` / `arousalAgitation 0.7`。

```js
function checkThresholds() {
  const triggers = []; const trace = [];
  const { connection: c, pride: p, immersion: i, valence: v, arousal: a } = state;

  // 观察区（不发出，只是内心念头）
  if (c >= 0.20 && c < 0.35) {
    triggers.push({ action: 'observation', urgency: (c - 0.20) / 0.15 });
    trace.push({ gate: '开口', fired: true, action: 'observation', reason: 'connection 进了观察区' });
  }

  // 考虑联系区：pride + immersion 门控
  if (c >= 0.35 && c < 0.50) {
    if (p >= 0.5) {                                  // 骄傲挡住开口
      if (i < 0.2) {
        triggers.push({ action: 'find_activity', reason: 'pride_block', urgency: c - 0.30 });
        trace.push({ gate: '开口', fired: false, divertedTo: 'find_activity', reason: 'pride 挡住，转身找事做' });
      } else {
        trace.push({ gate: '开口', fired: false, reason: 'pride 挡住，immersion 又缓冲住了' });
      }
    } else {
      triggers.push({ action: 'contact', urgency: c - 0.30 });   // 过了骄傲闸门 → 开口
      trace.push({ gate: '开口', fired: true, action: 'contact', reason: '过了 pride 闸门' });
    }
  }

  // 强制联系区：pride 无效
  if (c >= 0.50) {
    triggers.push({ action: 'contact', urgency: Math.min(1, c - 0.40), forced: true });
    trace.push({ gate: '开口', fired: true, action: 'contact', forced: true, reason: '过了强制线，pride 挡不住' });
  }

  // 低情绪自我调节：valence 过低 或 arousal 过高 → find_activity（若 immersion<0.3）
  if (v <= -1.0 || a >= 0.7) {
    if (!triggers.some(t => t.action === 'find_activity') && i < 0.3) {
      triggers.push({ action: 'find_activity', reason: v <= -1.0 ? 'low_valence' : 'high_arousal', urgency: 1 });
    }
  }
  return triggers;
}
```

**积累 → 犹豫 → 撑不住**：connection 到 0.35 想开口，但 pride≥0.5 会被挡去"找事做"；到 0.50 强制开口，骄傲失效。

### 1.4 三层成本模型（星澜可直接复用）

| 层 | 做什么 | 是否调模型 | 频率 |
|----|--------|-----------|------|
| 数学漂移 | 五轴随时间变化 | **不调** | 每 5 分钟 |
| 对话分析 | 读对话段，提取情绪 delta | 轻量模型 | 有新对话时 |
| 行动生成 | 生成开口内容 | 大模型 | 阈值触发时 |

对话分析只回几个 delta：`{ pride:-0.1, valence:+0.2, arousal:-0.05, connection:-0.15 }`——被夸 pride 降、聊开心 valence 涨、说完了 connection 降。**这层是"记忆 / 对话"与"动机引擎"之间的接口**，与星澜已有的 `recall_memory` / 对话历史天然契合。

### 1.5 给星澜的轴重映射（生活管家视角，不是恋人）

jiwen 的轴是从"嘴硬恋人"推出来的。星澜是**生活管家**，核心矛盾不同，轴要重映射——但**数学结构完全照搬**（确定性漂移 + 阈值触发 + trace）：

| jiwen 轴 | 星澜轴 | 驱动源（星澜已有数据） |
|----------|--------|------------------------|
| connection 0→1 | **牵挂度 care** | 距上次 owner 消息的分钟数 + 归一化"逾期/临期提醒压力" |
| pride -1→+1 | **克制度 restraint**（取反语义） | 默认高（0.6）；越想主动越往 0 掉；体现 DNA"在场不缠人" |
| valence × arousal | **栖光情绪面**（喂 `xinglanMood`） | 漂移提供两轮对话之间的"底色"，`moodFromText` 仍用于用户发言瞬间 |
| immersion 0→1 | **用户忙碌度 userBusy** | 已有 `userStatus`(active/busy/away/sleeping) 概念；高 → 缓冲开口 |

> 为什么克制 default 高：星澜的定位是"在场"而非"缠人"。pride 原版是"端着不开口"，星澜改成"克制 = 不该随便打扰"。`prideBlock` 门控变成"克制高就不弹软卡片，除非有硬截止"。这正好对应 `detectQuietHours` 的语义——把"免打扰"从离散的时间窗升格为**连续的动机轴**。

### 1.6 落地到 `server/`：新增 `server/proactive.ts`（零依赖纯函数，同构 `clarify.ts`）

设计原则照搬 `server/clarify.ts` 的成功经验（零依赖、可测、与 evals 共用一份判据）：

```ts
// server/proactive.ts —— 星澜主动动机引擎（确定性，不调模型）
export interface ProactiveState {
  care: number; pride: number; valence: number; arousal: number; immersion: number;
  lastMsgAt: number; lastTickAt: number;
}
export interface TriggerTrace { gate: string; fired: boolean; reason: string; detail: Record<string, number>; }

// 纯函数：推进状态（不落库、不调模型）
export function drift(state: ProactiveState, mins: number, ctx: {
  minsSinceLastMsg: number; overduePressure: number; userBusy: number; quietNow: boolean;
}): ProactiveState { /* 照搬 jiwen 的 clamp + 五轴公式，care 用 minsSinceLastMsg+overduePressure 驱动 */ }

// 纯函数：阈值判定，返回触发 + 可追溯轨迹
export function judge(state: ProactiveState, thr = DEFAULT_THR): { actions: ProactiveAction[]; trace: TriggerTrace[] } {
  // observation(0.20) → 仅记 trace，不弹卡
  // considerContact(0.35) + restraint<0.5 → 提议软卡片（暖金「人的环」）
  // forceContact(0.50) → 强制提议（但仍受 quietNow 约束，除非是硬截止）
  // userBusy(immersion) 高 → 缓冲开口（同 jiwen immersion 门控）
}

// 与 evals 共用一份断言：同样状态输入 → 同样动作输出（确定性，可复现）
```

**接进 `scheduler.ts`**：`tick()` 里把硬编码的

```ts
if (!quiet && hour >= 6 && !proactiveCardExistsSince(owner,'morning',...)) { ... }
if (!quiet && day === 5 && hour >= 18 && !proactiveCardExistsSince(owner,'weekly',...)) { ... }
```

换成

```ts
const st = loadProactiveState(owner);
const next = drift(st, minsSinceLastTick, { minsSinceLastMsg, overduePressure, userBusy, quietNow });
const { actions, trace } = judge(next);
// observation 类 → 只写 trace 日志（"注意到用户沉默"），不弹卡
// contact 类 → db.addProactiveCard(owner, 'checkin', ...actions)  // 已有的 ProactiveAction 壳
saveProactiveState(owner, next);
```

> **硬截止 vs 软主动的分工不变**：`reminder_due`（用户自己设的到期提醒）保持原逻辑——它是"硬截止"，绕过克制与免打扰；jiwen 引擎只驱动**软主动**（check-in / 晨报 / 复盘），让"什么时候发"从 cron 变成"动机到了才发"。

---

## 2. LIA 拆解

### 2.1 它是什么

- 仓库：`github.com/jgouviergmail/LIA-Assistant`（AGPL-3.0，150K+ 行，63 个 ADR，可跑树莓派）
- 技术栈：FastAPI + LangGraph 1.x + PostgreSQL；前端 Next.js 16 / React 19；6 LLM 提供商；SOPS/Age 加密；Prometheus/Grafana 可观测。
- 哲学一句话：**"I propose. You decide."**（我提你定）——LIA 可以**自主开启**可选对话，但每次开启都**记录为 LIA 自己的行为**，人类随时可否决 / 接管。

### 2.2 "我提你定"：Proactive Discussions + 6 层 HITL 审批

- **主动源已扩到 14 个**（v3.4.0）：LIA 依据自身策略和节奏主动开启对话，预算在花费前预留（under quotas/ceilings），原子发布后本地交付，私有开启屏蔽并远离外部渠道。
- **6 种审批类型（HITL）**：仓库明确标注 `Human-in-the-Loop (HITL) with 6 approval types`，但具体名称未在文件树暴露（需 clone 读 `docs/ADR-*`）。从提交看控制面包括：
  - 能力开关门控（`lib/capability-state.ts`，关闭的能力其工具离开执行模式）
  - 移交记录（每次交接两端都记，人类可追溯）
  - 私有模式 / 敏感话题（敏感话题自动转私有，需人类界定边界）
- **给星澜的映射**：星澜**不需要 6 层**。已有 `ProactiveAction[]`（`complete` / `snooze_hour` / `snooze_day` / `ask_agent` / `open_view`）就是"提→定"的两层最简版：星澜**提**一张卡，用户**点选**其中一个动作即等于"定"。这就是 LIA 哲学在零基础设施下的等价实现。

### 2.3 Psyche 功效引擎（情绪纽带）

- 代码中以 **"efficacy"（功效）** 模块落地：每次回答的表情在情感头像关闭时恢复中性；直接朗读的韵律遵循心理开关（`ADR-237`）。
- 2026-10-16 提交含 `psyche efficacy pilot` 设计与迁移；核心函数 `build_efficacy_block`（复杂度 CC14→13，重命名 `_coverage_gap` 过测试护栏）。
- **给星澜的映射**：星澜的 `utils/xinglanMood.ts` + `hooks/useXinglanPerformance.ts` + 栖光 orb **已经是一套 Psyche 引擎**——8 种 mood、定格 4.2s、空闲 75s 安睡、优先级链。差别只在：星澜 mood 现在主要靠 `moodFromText` 启发式；接上 jiwen 的 valence×arousal **连续漂移**，栖光就能在两轮对话之间也有"情绪底色"，不是每次都从 calm 起跳。

### 2.4 Heartbeat 主动触发

- 主动靠 **Heartbeat（心跳）+ Interests（兴趣）+ Proactive Discussions**。
- v2.3.0 已**去除每日配额与概率抽取**（ADR-328）——与 jiwen"不靠概率骰子"完全一致，说明两派独立走到同一结论：**主动不该是概率，该是状态**。
- v3.5.1 修过一个生产 bug：SMS 被误标私有，导致同一主题在每个 tick 重复（生日提醒发了 6 次）→ 教训：主动触发必须**幂等 + 去重**（`db.proactiveCardExists` 已做）。

### 2.5 BFF / token 隔离

- LIA 前端 Next.js **永不持有 LLM token**；密钥后端化（SOPS/Age + `.gitleaks`），API worker 一次性解析 MCP 向量。
- **星澜已有等价物**：单 Express 进程 serving `dist` + `/api`，前端只调 `/api/chat`，密钥只在服务端 `env`（见 MEMORY §五）。无需改动。

### 2.6 LIA 给星澜的一句话

> 别抄它的 150K 行。抄它的**姿态**：主动是"提议"不是"执行"；每次主动都署名、可追溯、人类随时能关。这三点星澜的暖金浮层 + `ProactiveAction` 已经满足 80%，差的那 20% 正是 jiwen 要补的"提议由确定性动机驱动"。

---

## 3. 合成：星澜的"可检视的主动"

### 3.1 数据流（新增 `proactive.ts` 后）

```
每 60s tick (scheduler)
   ├─ 硬截止分支（不变）：listDueReminders → reminder_due 卡（绕过克制/免打扰）
   └─ 软主动分支（新增）：
        loadProactiveState(owner)
        drift(state, mins, { minsSinceLastMsg, overduePressure, userBusy, quietNow })  ← jiwen 数学
        judge(state) → { actions, trace }                                            ← jiwen 阈值
           ├─ observation → 仅写 trace 日志（"注意到沉默"）
           ├─ contact(软) → addProactiveCard('checkin', actions)                     ← LIA 壳（暖金「人的环」）
           └─ trace 持久化 → 调试面板可看"为什么是现在"
```

### 3.2 与现有壳的接合点（零新增）

| 已有能力 | 在方案里的角色 |
|----------|----------------|
| `db.addProactiveCard` + `ProactiveAction[]` | LIA 的"我提你定"外壳（complete/snooze/ask_agent/open_view） |
| 暖金 `--gold #f6c062` 浮层「人的环」 | 软主动卡片的**唯一**视觉入口（MEMORY §六：确认 UI 单一入口） |
| 栖光 orb + `xinglanMood` | 由 jiwen 的 valence×arousal 漂移提供"两轮之间的情绪底色" |
| `detectQuietHours` / `isQuietNow` | 升级为连续 `restraint` 轴的特例（免打扰 = restraint 拉满） |
| `server/clarify.ts` 模式 | `proactive.ts` 同构：零依赖纯函数 + 与 evals 共用判据 |
| `db.proactiveCardExists` 去重 | 防止 LIA v3.5.1 那种"每 tick 重复"生产事故 |

### 3.3 零新基础设施清单

- 不新增表（或在 `proactive_state` 单表存五轴快照，复用 `db` 层）
- 不新增前端页面（卡片走已有「人的环」浮层）
- 不新增 LLM 调用（drift 纯数学；只有 contact 触发时沿用现有 `maybeAgent` 模板/模型路径）
- 不新增鉴权/沙箱（路线图明确本期不做）

### 3.4 验证（evals 同构 `clarify.ts`）

新增 `evals/proactive-decision.ts`：给定状态快照 → 断言动作集合（确定性、可复现、不调模型）。
判据与 `judge()` 共用一份，防止"文档改、代码未改"假通过（MEMORY §一：断言必须有证据）。

---

## 4. 风险与取舍

1. **轴语义重映射要调参，不是算出来的**（jiwen 原话："参数是调出来的"）。需 `simulate.js` 思路：写事件线看轨迹。星澜可加一个 `scripts/proactive-probe.ts` 挂 `npm test`。
2. **克制 default 高 → 可能"太冷淡"**（jiwen 诊断列 `in_force_contact` 太少）。需监控"多久没主动过一次"，设下限。
3. **栖光情绪由漂移驱动后，可能和 `moodFromText` 冲突** → 规则：用户发言瞬间以 `moodFromText` 为准，空闲期以 drift 为准，发言后 drift 向文本情绪收敛（同 jiwen valence 回归设定点）。
4. **别把"软主动"做成"镜子"**（前次 5 个设计被否的教训）：本方案不是"把用户数据换个好看样子还回去"，而是"管家自己决定什么时候开口"——是能力，不是展示。

---

## 5. 下一步建议（待你确认后再动手）

1. 写 `server/proactive.ts`（零依赖纯函数 + `drift` / `judge` / `trace`）。
2. 在 `scheduler.ts` 的 `tick()` 接入软主动分支，保留硬截止分支。
3. 加 `evals/proactive-decision.ts` + `scripts/proactive-probe.ts` 固化回归。
4. （可选）栖光情绪底色：把 valence×arousal 漂移喂进 `xinglanMood` 的空闲态。

> 全部完成后，星澜的主动服务从"早 6 点 / 周五 18 点准时弹"变成"动机到了才弹、且每一条都能解释为什么"。
