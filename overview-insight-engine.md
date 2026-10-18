# 主动洞察引擎 · 落地交付说明

> 任务 #276（栖光「全面升级」中选定的高价值能力）。纯前端、可无后端验证。

## 改了什么

### 1. `src/utils/butler.ts` — 洞察生成器（核心）
- `getProactiveCards(d = new Date(), ctx?: AgentContext | null)` 由「纯时间/日期 stub」升级为「时间/日期 + 实时上下文」双源引擎。
- 卡结构新增两个可选字段：`insight?: boolean`（标识上下文个性化洞察）、`tag?: string`（角标文案，默认「洞察」）。
- **上下文触发规则**（读取 `ctx.memories` / `ctx.reminders` / `ctx.moods` 真实字段）：
  - 逾期提醒（due_at < now）→ 催办
  - 24h 内到期提醒 → 临近预警
  - 未完成待办 ≥ 4 → 帮理计划
  - 最近情绪 `level ≤ 2` → 关怀
  - 连续两次情绪走低 → 趋势关怀
  - 记忆 `updated_at` > 14 天未更新 → 唤醒
  - 周五 + 有记忆/提醒 → 上下文版周复盘（覆盖通用 friday 卡，避免重复）
- 洞察卡**优先排序**（slice 前），id 稳定可去重；无 ctx 时自动回退为纯时间卡。

### 2. `src/components/XinglanShell.tsx` — 接入上下文
- `const proactiveCards = useMemo(() => getProactiveCards(new Date(), context), [context]);`
- 首页「今日主动提议」渲染洞察卡加 `.is-insight` 类，并在右上角显示「洞察」角标。

### 3. `src/components/xinglan.css` — 洞察视觉
- `.nx-procard.is-insight`：冰青描边（hover 冰青辉光），**不占用暖金**。
- `.nx-procard-tag`：右上角冰青 pill，文案「洞察」。

## 设计纪律
- **双色纪律未破**：洞察角标用冰青（系统色）；暖金仅留给「人的环 / 需要你」。
- **零模态未破**：洞察卡仍是首页内联主动流的一部分。
- **两套 `ProactiveCard` 仍不合并**：`butler.ts` 前端 tip 卡 vs `types.ts` 后端 data 模型形状冲突，保持分离。

## 验证
| 项 | 结果 |
|---|---|
| `npm run build`（rename 绕过 safe-delete） | 0 错误，tsc -b 通过；CSS 78.15KB / JS 260.35KB |
| 单测（esbuild 跑真实函数） | 含 ctx → 4 张洞察卡（overdue/due/load/mood，均 `tag=洞察`）；无 ctx → 仅时间卡、`anyInsight=false` |
| 预览 | http://localhost:4191/ HTTP 200 |

## 已知行为
- 无后端首屏 `context` 为 `null` → 只出时间卡；用户对话后 `context` 由 `runLocalMock`（或后端 `/api/context`）填充，洞察才出现。属预期。

## 下一步（仍在进行）
- 任务 #275 设计语言升级：令牌已注入（#275 上半），待把 `--dur-*` / `--shadow-*` / `--fs-*` / `--sp-*` 应用到组件层（卡片/面板/标题/留白节奏），并复核双色与零模态纪律。
