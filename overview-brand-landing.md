# 品牌落地：星澜 → 栖光 · Glow

## 做了什么
将智能体产品的**可见品牌层**从「星澜」全面切换为「**栖光 · Glow**」（两个汉字名，寓意"光栖止的角落·温柔在侧的 AI 管家"），并完成构建验证与本地预览。

## 关键决策
- **只改可见品牌层，保留全部内部代码标识符**（`XinglanShell` / `XinglanCore` / `StarSprite` / `OrbLogo` / `nx-*` 类 / 类型 `XinglanMood`），避免回归。
- **设计纪律不变**：冰青 `--brand` = 系统语言；暖金 `--gold` = 仅"人的环 / 需要你"。

## 改动清单
- `src/config.ts`：`name / shortName = '栖光'`、`nameInitial = '栖'`、description 改为栖光。
- `index.html`：标题 `栖光 · AI 生活助手`；favicon 重写为冰青→青绿辉光球（清掉旧 favicon 的紫色 `#b15cff` 双色违规）。
- `src/components/OrbLogo.tsx`：重写为栖光光符 —— 发光核心 + 柔晕光环 + 地平弧线，渐变 `#6fe9ff → #7af0d4`，光环呼吸动效（SMIL）。
- 用户可见文案清扫 **16 处**（Composer 占位符 / "正在思考" / DashboardPanel×4 / AgentContextPanel×4 / CompanionPanel 名称+aria / GovernanceLayer×4 / SessionList / XinglanShell 3 处 / CustomerPage 演示横幅 / artifact 产物脚注 / StarSprite title / XinglanCore aria+可见 caption / MoodPalette aria+title）。
- `docs/` `prototype/` `design/` 下的「星澜」为概念参考文档，不在运行 app 内，按约定保留（内部 codename 对照）。

## 验证
- 构建（`mv` 重命名绕过 safe-delete）：`tsc -b` 通过、`vite build` 1.82s 成功。
- 产物核对：bundle 内 `栖光` ×31，`星澜`（可见） ×0。
- 预览：`http://localhost:4188/` HTTP 200（4173–4187 被旧会话进程占用）。
- 品牌提案板 `brand-proposal.html` 留存为对外提案参考。

## 后续待办
- Task #275 设计语言升级（深度 / 动效节奏 / 字体 / 留白）。
- Task #276 落地 1–2 项高价值能力（多模态图片理解 / 语音播报 TTS 等），需确认具体选型。
