/**
 * 回归探针：聊天流「贴底跟随」+ 空态抓手 + 导航项结构
 *
 * 背景（2026-10-08 UI 审计 A 组）：
 *   A2 以前是 `useEffect(() => scrollTo(底部), [messages])`，没有任何前提判断——
 *      流式输出时每个 token 都把视图拽到底，用户往上翻看历史的权利等于被剥夺。
 *   A3 `.cv-scroll` 既无 overflow 也无 flex:1，ConversationView 里那个 ref 的 scrollTo
 *      是 no-op 死代码，实际靠父级 `.nx-chat-scroll` 碰巧生效，注释还写着"错开双滚动源"。
 *   A4 播放/暂停小标曾做成 `<span role="button" tabIndex={0}>` 嵌在 `<button>` 里。
 *
 * 这些都不是看一眼代码能发现的问题（尤其 A3 的"碰巧生效"），所以固化成断言。
 *
 * 运行：npx tsx scripts/ui-scroll-probe.ts
 */
import fs from 'fs';
import path from 'path';

const root = path.resolve(import.meta.dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

/**
 * 去掉注释后再断言。
 * 不这么做会出现最恶劣的假通过：注释里写着"已删除 xxx"，代码里 xxx 还在，
 * 断言因为匹配到注释而变绿。本项目吃过"文档已改、代码未改"的亏，测试里也必须防。
 */
const code = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} ${extra}`);
  }
};

console.log('\n[1] 贴底判定 isAtBottom');
const { isAtBottom } = await import('../src/hooks/useStickToBottom.js');
const box = (scrollHeight: number, scrollTop: number, clientHeight: number) => ({ scrollHeight, scrollTop, clientHeight });
ok('完全在底部 → 贴底', isAtBottom(box(1000, 600, 400)));
ok('距底 10px（平滑滚动余量）→ 贴底', isAtBottom(box(1000, 590, 400)));
ok('距底 55px（阈值内）→ 贴底', isAtBottom(box(1000, 545, 400)));
ok('距底 57px（阈值外）→ 不贴底', !isAtBottom(box(1000, 543, 400)));
ok('翻到顶部 → 不贴底', !isAtBottom(box(1000, 0, 400)));
ok('内容不足一屏 → 恒贴底（不会误判成"用户翻走了"）', isAtBottom(box(300, 0, 400)));
ok('阈值可配', isAtBottom(box(1000, 400, 400), 200) && !isAtBottom(box(1000, 400, 400), 56));

console.log('\n[2] 滚动纪律：ConversationView 不再自称拥有滚动');
const cv = code('src/components/ConversationView.tsx');
ok('已移除自己的 scrollerRef 与 scrollTo', !/scrollTo|scrollerRef/.test(cv));
ok('已移除 useEffect 自动滚动', !/\buseEffect\b/.test(cv));
ok('滚动归属写进了注释（防后人改布局时踩坑）', /唯一滚动源|不拥有滚动/.test(read('src/components/ConversationView.tsx')));
const cvc = code('src/components/XinglanConversation.css');
ok('.cv-scroll 确实没有 overflow（所以当年那次滚动是 no-op）', !/\.cv-scroll\s*\{[^}]*overflow/.test(cvc));

console.log('\n[3] Shell 侧：跟随时有条件，且给了「回到最新」出口');
const shell = code('src/components/XinglanShell.tsx');
ok('用 useStickToBottom 而非裸 scrollTo', /useStickToBottom/.test(shell) && !/chatScrollRef\.current\?\.scrollTo/.test(shell));
ok('贴底状态驱动「回到最新」按钮', /!pinned/.test(shell) && /nx-jump-latest/.test(shell));
ok('点击按钮回到最新', /onClick=\{stick\}/.test(shell));

const css = code('src/components/xinglan.css');
console.log('\n[4] 「回到最新」有定位基准');
const decls = (sel: string) =>
  (css.match(new RegExp(`\\${sel}\\s*\\{([^}]*)\\}`, 'g')) || []).join(' ');
ok('.nx-home-chat 是 position:relative（按钮的绝对定位基准）', /position:\s*relative/.test(decls('.nx-home-chat')));
ok('按钮没有挂在滚动容器 .nx-chat-scroll 上（absolute 会跟着内容滚走）', !/position:\s*relative/.test(decls('.nx-chat-scroll')));
ok('按钮样式已定义', /\.nx-jump-latest \{/.test(css));

console.log('\n[5] 空态抓手：能力卡真的被渲染了（不再是死代码）');
ok('homeCaps 已使用', /homeCaps\.map/.test(shell));
ok('CAPABILITIES 仍被引用', /CAPABILITIES\.slice/.test(shell));
ok('点击即发起（走统一 dispatch 出口）', /nx-welcome-cap[\s\S]{0,200}?dispatch\(c\.prompt\)/.test(shell));
ok('能力卡样式已定义', /\.nx-welcome-cap \{/.test(css));
ok('能力卡有 hover 反馈', /\.nx-welcome-cap:hover/.test(css));

console.log('\n[6] 导航项：不再有嵌套可交互元素');
ok('RailButton 外层是 wrap 而非 button 套 button', /<div className=\{`nx-rail-wrap/.test(shell));
ok('eq 是真 <button> 且是兄弟节点', /<button[\s\S]*?className="nx-rail-eq"/.test(shell));
ok('已删除 span[role=button] 补丁', !/role="button"/.test(shell));
ok('已删除 stopPropagation 补丁', !/stopPropagation/.test(shell));
ok('暂停/继续有可访问名', /aria-label=\{playing \? '暂停播放' : '继续播放'\}/.test(shell));
ok('状态类挂到 wrap 上（active/playing）', /nx-rail-wrap\$\{active \? ' active'/.test(shell));
ok('CSS 里不再有 .nx-rail-btn.active 旧选择器', !/\.nx-rail-btn\.active/.test(css));
ok('eq 只在真的播放时才跳动', /\.nx-rail-wrap\.playing \.nx-rail-eq i \{ animation/.test(css));

console.log('\n[7] 「此刻」是会走的时间');
ok('MomentBar 用 useNow 而非渲染时 new Date()', /const d = useNow\(\)/.test(shell));
ok('MomentBar 里没有裸 new Date()', !/function MomentBar[\s\S]{0,400}?new Date\(\)/.test(shell));
const nowHook = code('src/hooks/useNow.ts');
ok('useNow 有定时器', /setInterval/.test(nowHook));
ok('useNow 会清理定时器', /clearInterval/.test(nowHook));
ok('从后台切回前台会补一次（休眠后不显示旧时间）', /visibilitychange/.test(nowHook));

console.log('\n[8] 在场感：栖光不因为切走视图而消失');
ok('presence 是三元分支而非 view==="home" 短路（切走即卸载的旧写法）', /view === 'home' \? \(/.test(shell));
ok('非「此刻」分支渲染 PresenceOrb', /\) : \(\s*<PresenceOrb/.test(shell));
ok('在场球回传的是同一条情绪（mood 而非重新推导）', /<PresenceOrb[\s\S]{0,300}?mood=\{mood\}/.test(shell));
ok('点一下回到「此刻」', /<PresenceOrb[\s\S]{0,300}?onBack=\{\(\) => setView\('home'\)\}/.test(shell));
ok('等你确认时在场球转暖金（而不是静默）', /nx-presence-orb\$\{waiting \? ' waiting'/.test(shell));
ok('球有可访问名（读屏知道这是栖光、什么状态）', /aria-label=\{`栖光/.test(shell));
ok('CSS：球是绝对定位的常驻元件', /\.nx-presence-orb \{[\s\S]{0,200}?position: absolute/.test(css));
ok('CSS：球 z-index 低于停靠区 40（重叠时让主动卡在上）', /\.nx-presence-orb \{[\s\S]{0,300}?z-index: 35/.test(css));
ok('CSS：入场动画只淡入不带 transform（否则 fill-mode 盖掉 hover 位移）', /@keyframes nx-orb-in \{ from \{ opacity: 0; \} to \{ opacity: 1; \} \}/.test(css));
ok('CSS：氛围光是 absolute，精灵必须 position:relative 才压得住', /\.nx-presence-orb \.star-sprite \{ position: relative/.test(css));
ok('CSS：暖金态只改颜色不改结构', /\.nx-presence-orb\.waiting \{ border-color/.test(css));
ok('CSS：窄屏收掉标签以避让 bottom:90px 的停靠区', /\.nx-presence-orb-lab \{ display: none/.test(css));

console.log('\n[9] 音乐状态：切走音乐页也看得见、管得着');
ok('正在播放条挂在底部停靠区（与主动卡共享锚点）', /<div className="xl-bottom-dock">[\s\S]*?xl-now-playing/.test(shell));
ok('只在真的有曲目时出现', /musicState\.title && view !== 'music'/.test(shell));
ok('音乐页本身不重复出现', /view !== 'music'/.test(shell));
ok('能暂停 / 继续（走 xl-music-control 通道）', /xl-now-playing[\s\S]{0,900}?xl-music-control/.test(shell));
ok('能跳回播放器', /xl-now-playing[\s\S]{0,900}?setView\('music'\)/.test(shell));
ok('均衡器只在播放时跳动', /xl-np-eq\$\{musicState\.playing \? ' on'/.test(shell));
ok('曲名过长要省略（否则撑破停靠区）', /\.xl-np-t \{[\s\S]{0,200}?text-overflow: ellipsis/.test(css));
ok('按钮有显式外观（本项目无全局 button reset）', /\.xl-np-btn \{[\s\S]{0,300}?appearance: none/.test(css));

console.log('\n[10] 死 props 已清（声明却不用的 props 会误导后来人）');
const page = code('src/pages/CustomerPage.tsx');
for (const dead of ['now=', 'currentId=', 'onOpenSession=', 'onRemoveSession=']) {
  ok(`调用处不再传 ${dead.replace('=', '')}`, !page.includes(dead));
}
ok('Shell 不再解构 currentId', !/currentId/.test(shell));
ok('NowData 类型已随 now 一起移除', !/\bNowData\b/.test(shell));

console.log(`\n通过 ${pass} / 失败 ${fail}\n`);
if (fail) process.exit(1);
