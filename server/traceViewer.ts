/**
 * 回放级 trace 查看器（P0·2026-08-05-16-53-18）：自包含只读 HTML 的加载器。
 *
 * 为什么是独立 HTML 而非 React 页面：
 * - 前端指挥舱（src/）当前没有任何消费 /api/admin/runs 的页面；
 *   为「只读观测」新建一整个 React 路由成本高，且与「trace 红线：不回灌模型」的隔离诉求相悖。
 * - 一个静态、零依赖、只读的 HTML 既能在浏览器里直接打开回放，又不污染 SPA 状态。
 *
 * 服务器以 tsx 从源码运行（见 package.json dev:server），故 import.meta.url 解析到 server/，
 * 模板文件放在同级的 server/templates/ 即可稳定读取。
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 回放查看器的完整 HTML（自包含：内联 CSS + JS，纯前端拉取只读接口） */
export const TRACE_VIEWER_HTML = readFileSync(
  path.join(__dirname, 'templates', 'trace-viewer.html'),
  'utf-8'
);
