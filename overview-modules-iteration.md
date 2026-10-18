# 能力 / 历史 / 灵境模块 · 功能迭代升级

针对三块模块做内联的功能迭代，零浮层、零新后端依赖、复用现有设计令牌。构建通过、tsc 干净、Playwright 视觉核验三视图均符合预期。

预览：**http://localhost:4193/**

---

## 能力模块（Capability）

**改动**：`src/utils/butler.ts` + `src/components/XinglanShell.tsx` + `src/components/xinglan.css`

- 给 `Capability` 增加 `category` 字段（`plan` / `life` / `grow` / `create`），8 个能力按 4 个语义类目归类：
  - **出行与规划** — 规划一次出行 / 理一理我的日程
  - **生活与健康** — 推荐今晚做点啥 / 健康小习惯
  - **成长与陪伴** — 陪我学点东西 / 陪我聊聊
  - **实用与创作** — 帮我省点钱 / 帮我写点什么
- 能力视图顶部新增搜索框（`nx-cap-search`）：按 标题/描述/prompt 关键词模糊过滤；空态有「没有匹配的能力」提示。
- 能力视图按类目分块渲染：每个类目有「类目名 + 一句话提示」标题 + 卡片网格（`nx-cap-group` / `nx-cap-group-h` / `nx-cap-grid`）。
- 点击仍走统一 `dispatch` → 切回主页并发出。键盘可达、零浮层。

**视觉**：搜索框使用与 Composer 一致的玻璃表面令牌；类目前缀青色竖线；分组标题小字、提示灰字。**未引入暖金**（能力是系统语言模块）。

---

## 历史模块（History / SessionList）

**改动**：`src/components/SessionList.tsx` + `src/components/xinglan.css`

- **搜索**：顶部搜索框，按 标题/最后一条消息 关键词模糊过滤，右侧计数（`全部/已过滤` 形式如 `3/12 段`）。
- **日期分组**：按 `updated_at` 自动归桶 — 今天 / 昨天 / 本周 / 更早，组头小字且 sticky 跟随滚动。
- **末条消息预览**：会话卡片新增 `.session-preview` 块（2 行截断），使用 `s.lastMessage`。
- **空态优化**：区分「无任何对话」与「搜索无匹配」两种状态。
- 未引入新回调（自包含展示态），不改 `SessionSummary` 类型。

**视觉**：复用 `.session-item` 玻璃面；搜索框与能力搜索同语；分组头小字、低对比、sticky。零浮层。

---

## 灵境模块（Lingjing / DashboardPanel）

**改动**：`src/components/DashboardPanel.tsx` + `src/components/xinglan.css`

### 记忆 tab
- 新增工具条：搜索框 + 类目 chip 筛选（全部 + 来自数据的 kind 列表）。
- 卡片**展开/收起**：超过 80 字显示「展开」链接，展开后看到全文。
- 类目 chip 复用冰青激活态。

### 目标 tab
- 新增分段筛选（`.dash-seg`）：全部 / 进行中 / 已完成。
- 空态在「无数据」和「筛后为空」之间区分。

### 产物 tab
- 卡片**展开/收起**：超过 60 字显示「展开」链接；保留原「打开」动作。

### 能力 tab
- 保持原状（与独立 能力模块同源 `CAPABILITIES`）。

**视觉**：工具条用 `.dash-toolbar`（sticky 在 pane 顶部，渐变淡出底色），分段控件用 `.dash-seg` 玻璃胶囊；展开链接用 `.dash-link` 青色文字。**暖金纪律保持**：仅「进行中目标」数字与进度条使用金色（属于"人在做"的人态表达）。

---

## 设计纪律核验

| 项 | 状态 |
|----|------|
| 双色纪律：冰青=系统，暖金=人的环/需要你 | ✅ 仅 `进行中目标` 数字与进度条用金色；新增 UI 全用 brand |
| 零模态：所有反馈内联 | ✅ 搜索/筛选/展开全部内联，无 modal/drawer/popup |
| 复用令牌 | ✅ 全用 `--brand` / `--brand-soft` / `--gold` / `--surface-1` / `--border` / `--glass-hi` / `--shadow-sm` / `--dur-fast` / `--sp-*` 等 |
| 响应式 | ✅ 工具条/网格/分段控件自然 wrap；搜索框 100% 宽度 |

---

## 构建与验证

```
npx tsc --noEmit   → 0 errors
npm run build       → ✓ 75 modules, CSS 83.03 KB / JS 264.69 KB, 1.65s
preview :4193       → HTTP 200
```

**Playwright 探针**：
- `cap_search=1, cap_groups=4, cap_cards=8`，搜索「旅行」后 `cap_filtered_groups=1`（过滤到「出行与规划」类目）
- `hist_search=1, hist_count=1, hist_empty=1`（空态正确）
- `dash_search=1, dash_chips=1, dash_tabs=4, dash_seg=3`（分段 3 按钮全部/进行中/已完成）
- 控制台错误仅 `/api/*` 500（后端未起，预期），零页面错误

**截图**（`C:\tmp\`）：`shot_cap2.png` / `shot_hist2.png` / `shot_dash3_mem.png` / `shot_dash3_goals.png`，均已视觉核验。

---

## 改动文件清单

- `src/utils/butler.ts` — `Capability` 加 `category` + 新增 `CAPABILITY_GROUPS` / `CapCategory`
- `src/components/XinglanShell.tsx` — 能力视图加 `capQuery` / `capGroups` + 分组渲染
- `src/components/SessionList.tsx` — 搜索 + 日期分组 + 预览
- `src/components/DashboardPanel.tsx` — 记忆搜索/筛选/展开 + 目标分段筛选 + 产物展开
- `src/components/xinglan.css` — 新增 `.nx-cap-*` / `.nx-hist-*` / `.session-preview` / `.dash-toolbar` / `.dash-search` / `.dash-chips` / `.dash-chip` / `.dash-seg` / `.dash-link` 等样式
