# 高 star Agent 参照与星澜可借能力

> 背景：上一轮扒的 jiwen（积温）/ LIA 被判定"不怎么有用"——它们是恋人/陪伴小众赛道，解决浪漫关系里的"该不该先开口"，与生活管家不沾边。
> 本文件重搜**高 star、且功能扎实**的 agent / 助手类项目，筛出对星澜（本地优先、单用户、无鉴权无沙箱）**真有用、且能借**的能力，并落成落地方案。
>
> 核心结论：**星澜已有的"聊天 + 记忆 + 待办 + 定时提醒 + 栖光在场"功能集，正好就是高 star 项目 talorys 那套"最小有用助手"——方向没偏，不用追新功能，该做的是把记忆深度和生活教练层做厚。**

---

## 1. 高 star 项目 landscape（2026-10 快照）

绝大多数高 star agent 项目**不能直接给星澜用**，分三类：

| 类别 | 代表（约 star） | 为什么星澜借不了 |
|------|----------------|------------------|
| **框架/基建型** | AutoGPT(183–187K)、Dify(139–158K)、n8n(150–178K)、LangChain(135–148K)、LangGraph(23–43K)、crewAI(59K)、MetaGPT(70K) | 需要编排层与基础设施；星澜明确"本期不做鉴权与沙箱"，抄不动 |
| **渠道铺开型助手** | OpenClaw(37–39万)、AstrBot(41K)、OpenHands(58–91K) | 需要 20–29 个聊天渠道 + 沙箱 + 多用户；与星澜"单用户本地优先"模型冲突 |
| **编程 Agent** | OpenHands、Open Interpreter(58–68K)、Cline | 解决写代码/跑命令，与生活管家不是一回事 |

> ⚠️ **star 数水分提醒**：各源差异极大（OpenClaw 在 28 万–39 万间浮动），且很多"榜首"是 awesome-list / 技能合集索引而非可运行代码（如 `everything-claude-code` 18 万星只是 Claude Code 技能目录）。**看相对价值，别看绝对数字。**

---

## 2. 对星澜真有用的 4 件事（均符合无鉴权无沙箱约束）

| # | 借什么 | 来源项目 | 落地到星澜哪 | 改动量 |
|---|--------|----------|--------------|--------|
| **P1** | 记忆架构升级：4 桶分类 + 纯文件可检视 | Hindsight(38K, 4 桶) / OpenClaw(文件+混合检索) | `server/memory.ts` + `db/memories.js` | **小**（扩 kind + 加 episodic 写入 + 导出视图） |
| **P2** | "现状→理想状态"生活教练层 | LifeOS(19.6K) | 记忆 + 栖光/晨报轻推 | 中（需"理想状态"采集入口 + 对照逻辑） |
| **P3** | 自进化 routine 发现 | Hermes Agent(254K, 自进化 skill/cron) | 偏好推断升级为 routine | 中 |
| **P4** | skill/插件注册表当护城河 | OpenClaw(skill registry) | scheduler 主动源抽象为 plugin | 大（架构级，排最后） |

---

## 3. 落地方案

### P1 记忆架构升级（**推荐先做**：改动最小、收益最实，且是 P2/P3 的数据基础）

**现状（已读 `server/memory.ts` 真实结构）**
- `MemoryRecord`：`{ key, value, kind, updated_at }`，扁平列表存 better-sqlite3。
- `kind` 词表 + 权重：`preference 1.0 / fact 0.9 / plan 0.6 / note 0.4`。
- 打分：`selectMemories` = 相关性 0.6（2-gram 关键词命中 + key 加权）+ 新鲜度 0.3（30 天半衰 `1/(1+ageDays/30)`）+ 类型 0.1。
- **两个缺口**：① 只有"提取的事实"，**没有 episodic（某次对话发生了什么）记忆**——星澜能记住"用户喜欢茶"，却记不住"上周我们聊过换工作的事，ta 说纠结"；② 记忆只活在 sqlite，**不可直接检视**（OpenClaw 用纯 Markdown 文件，人能直接读）。

**借 Hindsight 的 4 桶分类**（World / Experiences / Observations / Mental models）：

| Hindsight 桶 | 星澜映射 `kind` | 含义 | 建议权重 |
|--------------|----------------|------|----------|
| World（稳定事实） | `fact` | 关于用户/世界的不变事实 | 0.9（已有） |
| Experiences（经历） | **`experience`（新增）** | 某次对话发生了什么、结论是什么 | 0.7 |
| Observations（观察） | **`observation`（新增）** | 模型从交互观察到的（情绪/状态推断） | 0.85 |
| Mental models（心智模型） | **`mental`（新增）** | 对用户的抽象理解（"夜猫子""决策前需要选项"） | 0.95 |

保留 `preference / plan / note` 向后兼容（旧行不动）。

**具体改动清单**

1. **扩 kind 词表**（零破坏）：
   - `server/db/memories.js`：`kind` 校验放开到 `preference|fact|plan|note|experience|observation|mental`。
   - `server/memory.ts`：`KIND_WEIGHT` 增加 `experience:0.7, observation:0.85, mental:0.95`。
2. **加 episodic 写入**（数据基础）：
   - 在 agent 主循环 / `recall_memory` 命中后，当一轮对话产生"可复用结论"时，写一条 `experience`（key=话题，value=发生了什么+结论）。
   - 复用现有 `save_memory` 工具，只改 `kind` 入参；无需新工具。
3. **`selectMemories` 加 episodic 弱召回**：
   - query 为空或模糊（token 少）时，给最近 `experience` 轻微加权（`recencyBoost`），让星澜能说"上次我们聊过 X"。
   - 仍是纯函数、可测（同构 `clarify.ts` 纪律）。
4. **记忆可检视导出**（OpenClaw 教训：记忆纯文件可读）：
   - 加 `GET /api/debug/memory?owner=` 或 `scripts/memory-export.mjs` 导出 Markdown（按 kind 分组），方便调试与"可检视"主张。
   - 不落新表，只读现有 `db.getMemories`。

**验证**：扩展 `evals/` 或加 `scripts/memory-probe.mjs` 挂 `npm test`，断言：①新 kind 能写入；②模糊 query 下 recent `experience` 被召回；③旧行权重不变（向后兼容）。

---

### P2 "现状→理想状态"生活教练层（LifeOS）

**概念**：用户告诉星澜"我是谁、在乎什么、想去哪"，星澜用"懂你"的 AI 把用户从**现状推到理想状态**——不是镜子（只看自己），也不是更多按钮，而是"陪你走向想成为的样子"。

**落地**
- 新增记忆采集入口：首次/主动问"你最近在往哪个方向走？"，存为 `plan` 的扩展（或 `mental`："理想状态=…"）。
- 晨报 / 栖光轻推里加一句对照："你说过想 X，这周可以迈出一小步：…"——复用 `buildMorning` 的 `pickBriefMemories` 逻辑，挑出 `plan`/`mental` 类。
- **改动中**：需"理想状态"采集 UI（可先走对话采集，不急前端） + 对照生成（模板即可，沿用 `maybeAgent` 路径）。

---

### P3 自进化 routine 发现（Hermes Agent）

**概念**：把"完成的工作"沉淀成可复用 routine，越用越懂用户。

**落地**
- 星澜已有偏好推断方向（`checkin_mood` / insight 层）。升级为：检测"用户反复做的事"（如每周五写周报、每晚 11 点后少打扰），自动记成 `routine` 记忆。
- 下次到时点，主动预填（如周五下午问"要不要帮你起周报草稿？"）——这正好是 scheduler 软主动的**真实信号源**（替代 jiwen 情绪轴）。
- **改动中**：需 routine 检测逻辑（低频，可放 scheduler 心跳里跑），数据靠 P1 的记忆升级兜底。

---

### P4 skill/插件注册表护城河（OpenClaw，远期）

**概念**：主动能力做成可插拔插件，社区可扩，形成护城河。

**落地**
- 把 `scheduler.ts` 的主动源（`reminder_due` / `morning` / `weekly`）抽象成统一 `ProactiveSource` 接口（每个插件暴露 `shouldFire(state) → card`）。
- **改动大（架构级）**，且当前主动源只有 3 个，抽象收益低——**排最后**，等 P1–P3 数据厚了再做。

---

## 4. 不做的事（红线）

- ❌ **不搬 jiwen 情绪轴**做主动时机——生活管家的"何时主动"应来自待办/记忆/习惯**真实信号**（P3 routine），不是浪漫关系的"思念累积"。
- ❌ 不搬渠道铺开 / 沙箱 / 多用户（与"单用户本地优先、无鉴权无沙箱"硬约束冲突）。
- ❌ 不搬框架编排（AutoGPT/Dify/LangGraph 那套）。
- ❌ 不做更多"镜子"式展示（前次 5 个设计被否的教训）。

---

## 5. 建议的下一步

**先做 P1（记忆升级）**——理由：
1. 改动最小（扩 kind + 加写入 + 导出视图，不动架构）；
2. 收益最实（补上 episodic 缺口，星澜立刻"记得聊过什么"，不是只记得标签）；
3. **是 P2/P3 的数据基础**——没有丰富的 `experience`/`mental` 记忆，生活教练层和 routine 发现都是空转。

P1 完成后，P3（routine 发现）可直接吃 P1 的数据做软主动信号源，自然替代被否的 jiwen 情绪轴方案。
