/**
 * 回归探针：CSS 卫生（死类 / 响应式失效）
 *
 * 背景（2026-10-09 D 组审计）：
 *   1. 响应式四档（1080/900/860/640）几乎全在打**已被删除的旧布局类名**
 *      （.nx-companion / .nx-home / .nx-stage / .nx-perception，tsx 里 0 引用），
 *      真实生效的只有 980px 一档 —— "写了但没生效"，比没写更误导。
 *   2. xinglan.css 有 432 个类选择器，131 个无人使用（31%）。
 *      后果不是体积，而是**每一次 UI 改动都要在死规则里翻找活的规则**。
 *
 * 本探针锁住两件事：
 *   A. @media 里的选择器必须全部"活着" —— 死规则在响应式里是静默失效，最难发现。
 *   B. 全文件死类总数只允许下降，不允许上升（基线 BASELINE）。
 *
 * ⚠️ 判定必须剥掉注释：我在注释里点名旧类名会被当成选择器（假存活），
 *    反过来 tsx 注释里写着"已删除 xxx"也会造成假存活。两侧都要剥。
 *
 * 运行：npx tsx scripts/css-hygiene-probe.ts
 */
import fs from 'fs';
import path from 'path';

const root = path.resolve(import.meta.dirname, '..');

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? `  → ${extra}` : ''}`); }
};

/** 剥注释：CSS 的 /* *\/ 与 ts/tsx 的 // （// 要排除 https://） */
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

/** 由模板动态拼出的类名，静态扫不到，必须白名单放行（漏了就会误杀） */
const DYNAMIC = new Set(['art-report', 'art-checklist', 'art-note']);
/** 死类基线：2026-10-09 清理后剩余 22（都在"死类 + 活后代"的后代选择器里，删不得）。
 *  只允许下降，上升说明又攒了新的死规则。 */
const BASELINE = 22;

const cssRaw = fs.readFileSync(path.join(root, 'src/components/xinglan.css'), 'utf8');
const css = strip(cssRaw);

// —— 收集源码里真实出现过的标识符 ——
const files: string[] = [];
const walk = (d: string) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (!['node_modules', '.git'].includes(e.name)) walk(p); }
    else files.push(p);
  }
};
walk(path.join(root, 'src'));
const tsx = strip(files.filter((f) => /\.tsx?$/.test(f)).map((f) => fs.readFileSync(f, 'utf8')).join('\n'));
const otherCss = strip(
  files.filter((f) => f.endsWith('.css') && !f.endsWith('xinglan.css')).map((f) => fs.readFileSync(f, 'utf8')).join('\n'),
);
const toks = new Set(tsx.split(/[^A-Za-z0-9_-]+/).filter(Boolean));

const allSels = [...new Set([...css.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((x) => x[1]))];
const isDead = (c: string) => {
  if (DYNAMIC.has(c)) return false;
  if (new RegExp(`\\.${c.replace(/-/g, '\\-')}\\b`).test(otherCss)) return false;
  return !toks.has(c);
};
const dead = allSels.filter(isDead);

// —— 切出 @media 块（大括号配平）——
const mediaBlocks: { cond: string; body: string; line: number }[] = [];
const re = /@media[^{]*\{/g;
let m: RegExpExecArray | null;
while ((m = re.exec(css))) {
  let depth = 1;
  let i = re.lastIndex;
  while (i < css.length && depth > 0) { if (css[i] === '{') depth++; else if (css[i] === '}') depth--; i++; }
  mediaBlocks.push({
    cond: m[0].slice(0, -1).trim(),
    body: css.slice(re.lastIndex, i - 1),
    line: css.slice(0, m.index).split('\n').length,
  });
}

console.log('\n[A] 响应式：@media 里的选择器必须全部在用');
ok('至少存在 3 档响应式断点', mediaBlocks.filter((b) => !/hover|prefers/.test(b.cond)).length >= 3,
  `实际 ${mediaBlocks.filter((b) => !/hover|prefers/.test(b.cond)).length} 档`);
const mediaDead = new Set<string>();
for (const b of mediaBlocks) {
  for (const c of [...new Set([...b.body.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((x) => x[1]))]) {
    if (isDead(c)) mediaDead.add(`${c}（${b.cond} 第 ${b.line} 行）`);
  }
}
ok('没有任何 @media 规则指向已删除的类名', mediaDead.size === 0, [...mediaDead].join('; '));

console.log('\n[B] 响应式断点打到真实结构上');
for (const cls of ['nx-stage-body', 'nx-rail', 'nx-top', 'nx-feedback']) {
  const hit = mediaBlocks.filter((b) => new RegExp(`\\.${cls}\\b`).test(b.body));
  ok(`${cls} 在窄屏有对应规则`, hit.length > 0);
}
ok('非「此刻」视图覆盖了网格行（否则 .nx-side 被塞进 300px 的第一行）',
  /\.nx-stage-body\.wide \{[\s\S]{0,120}?grid-template-rows/.test(css));

console.log('\n[C] 死类总量：只允许下降');
ok(`死类数 ${dead.length} ≤ 基线 ${BASELINE}`, dead.length <= BASELINE, dead.join(' '));
ok('已不再有整代废弃布局的类名（companion / now / procard / hx- 系列）',
  !allSels.some((c) => /^nx-companion$|^nx-now$|^nx-procard$|^hx-root$|^nx-perception$/.test(c)),
  allSels.filter((c) => /^nx-companion$|^nx-now$|^nx-procard$|^hx-root$|^nx-perception$/.test(c)).join(' '));

console.log('\n[D] 反馈栈：告知型通知有唯一容器');
const shell = strip(fs.readFileSync(path.join(root, 'src/components/XinglanShell.tsx'), 'utf8'));
ok('notice 与 offline 同属 .nx-feedback', /className="nx-feedback"[\s\S]{0,400}?nx-inline-notice[\s\S]{0,300}?nx-inline-offline/.test(shell));
ok('栈空时不渲染空盒子', /\(notice \|\| offline\) &&/.test(shell));
ok('子节点不再各自写 margin（间距归栈管）', !/\.nx-inline-(notice|offline) \{[^}]*margin/.test(css));
ok('「需要你」的暖金条不进栈（它是中断，不是告知）', /nx-needy-float/.test(shell) && !/nx-feedback[\s\S]{0,600}?nx-needy/.test(shell));

console.log(`\n通过 ${pass} / 失败 ${fail}\n`);
if (fail) process.exit(1);
