# 设计语言升级 · 落地交付说明

> 任务 #275（栖光「全面升级」）。**仅改动 `src/components/xinglan.css` 一个文件**，零逻辑变更、零组件改动。

## 改了什么

### A. 玻璃景深（elevation depth）
把已注入的 `--glass-hi`（顶部 1px 内高光）与层级化阴影真正接到所有「需要浮起来的面」。

**主面板**（升到 `var(--glass-hi), var(--shadow-md)`）：
- `.nx-companion`（右侧陪伴面板）
- `.nx-dash`（灵境仪表盘）
- `.ctx-rail`（管家此刻右栏）
- `.composer-box`（输入框）

**卡片 / 瓦片**（统一补齐 `var(--glass-hi), var(--shadow-sm)`）：
- `.chat-bubble` / `.nx-procard` / `.artifact-card` / `.nx-pro-inline` / `.nx-inline-notice` / `.confirm-card.is-resolved`
- 7 类瓦片卡：`.chip` / `.nx-cap` / `.session-item` / `.stat-card` / `.panel-card` / `.ctx-chip` / `.ctx-item`（从仅 inset 高光 → 高光 + 外阴影）

### B. 动效节奏（animation rhythm）
所有 transition / animation 时长统一到 `--dur-fast` / `--dur` / `--dur-slow`：
- 机械 token 化（`replace_all` 锚定 `var(--ease)` 共现）：
  - `0.2s var(--ease)` → `var(--dur-fast) var(--ease)`（×12 处：rail-btn、mic、chip、composer-send、confirm-btn、art-btn、rs2-mood-btn、session-item、new-chat-btn、companion-collapse、pro-later、pro-accept、needy-bar…）
  - `0.25s var(--ease)` → `var(--dur) var(--ease)`（×procard、cap…）
  - `0.3s var(--ease)` → `var(--dur) var(--ease)`（×xc-node、nx-rise 动画…）
  - `0.4s var(--ease)` → `var(--dur-slow) var(--ease)`（×xc-core、confirm-card nx-pop…）
- 手动 token 化（裸时长，无 `var(--ease)` 共现）：`.nx-aurora` `0.5s`→`--dur-slow`、`.xc-mesh line` `0.3s`→`--dur`、`.composer-box` 裸 `0.2s`（border-color/box-shadow 双属性）→`--dur-fast`

### C. 字体层级（type scale）
- `.nx-now-greet h2` 22px → `var(--fs-display)` 27px（hero 加大）
- `.nx-mod-head h3` / `.nx-cap-head h3` / `.dash-header h2` / `.nx-welcome-h` → `var(--fs-h2)` 19px（section 标题统一）
- `.nx-section-h` 13px → `var(--fs-sm)` 12.5px（小标签统一）

### D. 留白节奏（spacing rhythm）
- `.nx-companion`：gap 14px / padding 16·16·18 → `--sp-4` / `--sp-4`/`--sp-4`/`--sp-5`
- `.nx-top`：padding 18/26/14 → `--sp-5`/`--sp-6`/`--sp-4`
- `.ctx-body`：14/16 → `--sp-3`/`--sp-4`
- `.dash-header`：18/20 → `--sp-5`/`--sp-5`
- `.dash-content`：16/20/22 → `--sp-4`/`--sp-5`/`--sp-6`
- `.nx-procard`：16 → `--sp-4`
- `.nx-cap`：18 → `--sp-5`

## 设计纪律
- **双色纪律未破**：洞察 / 系统一律冰青；暖金仍只留给「人的环 / 需要你」。
- **零模态未破**：所有改动都在 `xinglan.css`，无任何浮层新增。
- **无逻辑变更**：只动 CSS，不动任何 `.tsx` / `.ts`。

## 验证
| 项 | 结果 |
|---|---|
| `npm run build`（先 `mv dist.bak /tmp/...` 释放残留） | 0 错误，tsc -b 通过；**CSS 78.94 KB** / JS 260.35 KB / 75 modules |
| 残留字面量 | 0 个内高光字面量；0 个裸 0.2/0.25/0.3/0.4/0.5s 过渡时长 |
| Token 实际使用 | `--dur-fast`×12 / `--dur`×7 / `--dur-slow`×3 / `--glass-hi`×17 / `--shadow-md`×4 / `--shadow-sm`×15 / `--fs-display`×1 / `--fs-h2`×4 / `--fs-sm`×1 / `--sp-3..6` 共 12 处 |
| Playwright 截图 | home / cap / dash / chat 四态，玻璃质感与字/距节奏肉眼可辨（存 `C:\tmp\shot-*.png`） |
| 控制台 | 0 页面错误，仅后端 `/api/*` 500（无后端预期） |

预览：**http://localhost:4192/**
