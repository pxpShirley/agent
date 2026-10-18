# 栖光 · 拟光（Lumen Future）— 未来 Agent 交互重设计 · 交付概览

> 视角：**规范范 / Diana**（拟人化、极致美观、情感化反馈）
> 承接：`doc-architecture-analysis.md`（架构）、`PRD-proactive-surface-convergence.md`（P0 主动开口）、`design/*`（早期探索）

## 本轮交付三件套

| 文件 | 类型 | 内容 |
|---|---|---|
| `DESIGN-xinglan-future.md` | 设计规范（权威真相源） | 现状痛点分析 + 整体风格定义 + 9 章设计系统 + 关键交互场景 + 拟物化元素说明 + AI 提示指南 |
| `prototype/xinglan-future.html` | 自包含可运行原型 | 在场舞台 + 单一拟物主体（栖光）+ 感知流 + 人的时刻（暖金 lean-in）+ 3 个可播放协作场景 |
| 本文 | 概览 | 交付说明与衔接 |

## 核心设计主张

**让 Agent 成为一个"在场的人"，而不是一个"更聪明的对话框"。**

## 解决的 8 项痛点（P1–P8）

- **P1 主动开口三套割裂** → 统一为「感知流 Perception Stream」（后端 `getHomeOpening` 聚合落地，死代码 `getProactiveCards` 退役）。
- **P2 拟人主体分裂**（orb 能量球 + mochi 麻糬双脸）→ 收敛为**单一主体**：mochi 为本体，orb 降级为它的 aura 光晕。
- **P3 陪伴=侧栏** → 栖光登上**在场舞台中央**，对话发生在"你和它之间的空气里"。
- **P4 情绪手动覆盖** → 改为**状态机涌现**（thinking/speaking/waiting/happy/concerned 由运行时推导）。
- **P5 人的时刻像告警** → 暖金重定义为"**尊重色 / 让渡**"，居中 lean-in，主按钮仍走冰青。
- **P6 主页 8 层同屏** → 坍缩为「栖光 + 对话 + 轻声」，记忆/治理降级为轻推侧湖。
- **P7 缺乏连续在场** → 任意子视图下栖光以"栖息态"留在角隅。
- **P8 感知无在场感** → 主动性先"注意"后"轻声"，空间语言替代系统推送。

## 双色纪律 · 升华

- 冰青 `--brand` = 系统语言（栖光常态 + 所有功能界面）。
- 暖金 `--gold` = **仅**"人的时刻 / 让渡决策"，不再用于成功/警告/错误（语义色走独立低饱和 `--good/--bad/--info`）。

## 原型可交互演示

打开 `prototype/xinglan-future.html` 后，底部演示条可播放：
- **▶ 播放「协作规划周末」**：listening → thinking（轨道子节点亮起）→ speaking（流式回复）→ 人的时刻（暖金 lean-in）→ 确认后 happy。
- **主动感知**：栖光"注意到"作息，concerned 轻声关怀。
- **情感闭环**：happy 完成 → sleeping 安睡。

栖光的眼睛会随鼠标转向你（眼随你），常态轻呼吸，切换状态时光晕颜色与表情自然变化。

## 与既有交付衔接

- 设计解决架构分析中的"主动能力三套割裂""拟人化未收口"两项缺口。
- 感知流 = PRD `getHomeOpening` 的视觉落地形态；实现锚点：`StarSprite.tsx` / `XinglanShell.tsx` / `xinglan.css` / `useServiceChat.ts` / `server/scheduler.ts`。
