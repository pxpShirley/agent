# 收敛 IA · React 回灌实现

承接 UI Designer 的高保真方案 `prototype/xinglan-next.html`，把"能力溶解 / 历史降级 / 灵境去重 / 每日简报"完整移植到实际 React 层。**只动：去掉冗余 + 添新功能 + 复用令牌**，零新后端依赖，零 modal/dialog 弹窗。

## 改动一览

| 文件 | 性质 | 要点 |
|------|------|------|
| `src/utils/butler.ts` | **新增** | `BriefRow` 类型 + `getDailyBrief(d, ctx?)`：2×2 简报从真实 `AgentContext` 派生（今日目标 / 临近提醒·需要你·暖金 / 记忆关怀 / 今日建议） |
| `src/components/CommandPalette.tsx` | **新建** | ⌘K 命令面板：跨 能力/记忆/历史 统一检索、↑↓↵Esc、遮罩点击、选中滚入视野 |
| `src/components/XinglanShell.tsx` | **改** | Rail 收敛 4 项（主页/我的/历史/治理）；删 capability & history 视图；主页加 每日简报 + 内联 cap chips；接入 ⌘K 与历史抽屉 |
| `src/components/DashboardPanel.tsx` | **改** | 删重复的"能力" tab（Tab 类型由 4 收为 3） |
| `src/components/xinglan.css` | **追加** | 简报 / 内联 chips / 历史抽屉 / ⌘K 面板样式（全部用现有令牌） |

## IA 决策（落地版）

- **Rail 常驻 3 + 1 抽屉触发**：
  - 主页（对话 + 简报 + cap chips）
  - 我的（灵境 3 tab：记忆 / 目标 / 产物 — 不再有"能力"）
  - 治理（内联区域）
  - 历史（右侧抽屉，Rail 按钮上有金色小点表示有会话）
- **能力** 已无独立页面：主页「此刻适合」4 个 chip（旅行 / 日程 / 放松 / 健康） + ⌘K 命令面板
- **历史** 已无独立页面：右侧抽屉，遮罩点击 / Esc 关闭，选中即关抽屉+打开会话
- **每日简报**：2×2 内联卡，今日目标 / 临近提醒(需要你·暖金) / 记忆关怀 / 今日建议；点卡 → `dispatch`

## 设计纪律

- **双色**：暖金仅两处——简报「需要你」与进行中目标进度（已在 DashboardPanel）。其他新增 UI 全部冰青。
- **零模态**：抽屉与 ⌘K 是新增的覆盖层，但用遮罩+Esc 关闭，无 dialog 弹窗；其余反馈全部内联。
- **统一 dispatch**：所有出口（内联 cap chip / 简报行动 / ⌘K / 抽屉选会话）都汇入同一条 `runCommand → dispatch` 路径（关浮层 + 切主页 + 发送）。
- **零新后端依赖**：`getDailyBrief` 与 `CommandPalette` 都接受 `context / sessions` props，运行时由 `CustomerPage` 传入，未改其类型。

## 验证

- `npx tsc --noEmit` → **0 errors**
- `npm run build` → **✓ 76 modules，CSS 90.27 KB / JS 265.26 KB**
- preview **http://localhost:4194/** → HTTP 200
- Playwright 全链路（`c:/tmp/verify_converge.cjs`，设 `seenDemo=1` 跳过新手指引以呈现空态）：

  | 探针 | 结果 |
  |------|------|
  | Rail 常驻项 | `["主页","我的","历史","治理"]` |
  | 每日简报 | `present=1, rows=3`（无 ctx 空态，少 overdue 1 行） |
  | 内联能力 chips | `4` |
  | 灵境 tabs | `["🧠 记忆","🎯 目标","📦 产物"]`，`hasCapTab=false` |
  | 历史抽屉 | `open=1 → Esc → 0` |
  | ⌘K 面板 | `open=1, items=8, groups=["能力"], 搜"旅行"→items=1, Esc→closed=0` |
  | 控制台错误 | 仅 `/api/*` 500（后端未起，预期），0 page error |

- 视觉核验（`C:\tmp\shot_converge_*.png`）：
  - **home**：每日简报 2×2 卡（左侧青紫渐变条 + 暖金「需要你」位）+ 4 cap chips + 顶栏 ⌘K 按钮
  - **mine**：3 tab 灵境（无「能力」），4 stat 卡（0/0/0/86%）
  - **hist**：右侧抽屉滑出，标题 + 关闭 X + 搜索 + 空态
  - **cmdk**：遮罩模糊，命令面板居中，搜索 + 分组 + 列表 + 底部 ↑↓↵esc 提示

## 与产品原型的对应

| 原型 (`xinglan-next.html`) | React 落地 |
|------|------|
| Rail 3+1 | `XinglanShell` Rail 4 项（主页/我的/历史·drawer/治理） |
| 简报 `.brief` / `.brow` | `nx-brief` / `nx-brow` |
| 内联能力 chips | `nx-cap-chips` / `nx-cap-chip` |
| `.drawer` + `.ghost-x` | `nx-hist-drawer` + `nx-hist-mask` |
| `.palette-mask` / `.palette` | `nx-cmdk-mask` / `nx-cmdk`（`CommandPalette` 组件） |
| `setView('home')` | 统一由 `runCommand` 完成 |

## 文件清单

- `src/components/CommandPalette.tsx`（新建）
- `src/utils/butler.ts`（加 `BriefRow` / `getDailyBrief`）
- `src/components/XinglanShell.tsx`（IA 收敛 + 简报 + ⌘K + 抽屉接线）
- `src/components/DashboardPanel.tsx`（删重复能力 tab）
- `src/components/xinglan.css`（追加新组件样式）
- `prototype/xinglan-next.html`（设计原型，留档）
- `overview-ui-next.md`（设计说明，留档）
- 预览：**http://localhost:4194/**
