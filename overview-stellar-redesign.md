# 交付概览 · 左侧形象页改版（星辰星光模式 · 角色在场 + 星河流转）

## 本轮更新（用户反馈驱动）
按反馈**保留原有的拟人化角色形象（栖光）**，并把执行链的视觉从「圆形球体 + 连线的静态星座」**重新设计为「星星流转般绚丽动态」的星河流转**——一条沿平滑曲线持续流动的粒子星河，配合柔光团与彗星脉冲表达推进，全程**无静态圆圈、无连线**。同时确认：项目中其他功能相关页面（真实 `src/` 的 home / dashboard / history / governance，以及既有 `xinglan-future.html` 等原型）**均保持完整，未被改动或删除**。

## 交付物
| 文件 | 角色 |
|---|---|
| `prototype/xinglan-stellar.html` | 自包含可运行原型（JS 已通过 `node --check`）。预览已打开 |
| `DESIGN-left-persona-redesign.md` | 左侧形象页改版方案：现状基线 / 三档布局 / 四区内容结构 / 执行链↔形象页驱动映射 / 双色纪律衔接 / 验收 |
| `DESIGN-stellar-mode.md` | 星辰星光模式渲染规范（已同步更新 §1/§3.2/§4/§5/§7：星河流转而非静态连线） |
| `overview-stellar-redesign.md` | 本文件 |

## 核心设计
- **栖光本人始终在场**：左侧形象页中央是拟人化角色栖光——圆润发光躯体、会随光标转动的眼睛、轻呼吸、情绪 aura 光晕、环形星光点缀。**不再用星座替代角色**。
- **执行链 = 环绕她的星河**（动态）：步骤锚点沿一条 Catmull-Rom 曲线排布，河面由持续流动的星点构成（闪烁、错相、明暗分段）；某步激活时一颗**彗星**沿河面流向上一步→当前步，抵达后该处柔光团增亮。**无圆形节点、无连线**。
- **执行链是唯一真相源**：`steps[]` 的 `status`（pending/active/done/waiting）纯函数映射到——柔光团亮度/色、彗星脉冲、河面高亮段、栖光 aura、caption、链图例、human-moment。视觉层只「读」链，不「写」链。
- **双色纪律坚守**：冰青=系统语言（星河主色）；**暖金仅用于「交还决策」(waiting) 与人的时刻**。
- **完整交互闭环**：点选链图例任一行 → detail 展开该步；`waiting` 步骤自动触发「人的时刻」浮层，决策后链继续点亮 `settle` 并沉降为轻呼吸。

## 原型可玩（底部演示条）
- **▶ 运行执行链**：星河按序点亮、彗星脉冲逐段流过，右侧对话同步；到「交还决策」整段星辉转暖金并弹出人的时刻。
- **主动感知**：concerned 态 + 感知流金条（链即使被动也在驱动形象）。
- **情感闭环**：全链青亮 → 安睡沉降（aura 转柔）。
- **重置**：回到在场轻呼吸。

## 回灌锚点（真实代码）
- `src/components/StarSprite.tsx` → 保留并增强为「栖光拟人本体」（眼睛随光标、呼吸、aura）。
- 新增 `StarRiver.tsx` → canvas 星河流转（复用 `steps[]`、`activate()`、`mood` 词汇）。
- `src/components/XinglanShell.tsx` → 左侧 `rail` 改 `persona` 容器，`dispatch` 同时驱动对话与 `ExecutionChain`。
- `src/components/xinglan.css` → 粘贴 `DESIGN-stellar-mode.md` §6 的 `:root[data-mode="stellar"]` 令牌。
- `server/scheduler.ts` / `useServiceChat.ts` → SSE 的 `tool`/`tool_result`/`ask_user` 即 `activate()` 的真实数据源。

## 验收
AC1 三档断点不溢出/不重叠、触控≥44px；AC2 星河按执行序点亮、彗星方向与链序一致；AC3 仅交还呈暖金；AC4 图例点击联动 detail；AC5 reduced-motion 下星河静止但状态/信息完整可读；AC6 暖金仅人的时刻；AC7 角色形象与执行链共存，无静态圆圈+连线表现。
