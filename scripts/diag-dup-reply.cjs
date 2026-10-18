/**
 * 复现「界面里同一条助手回复出现两份」的问题。
 * 发送一句话 → 等待完成 → 同时比对：
 *   1) 界面上助手消息条数（是否 2 条）
 *   2) DOM 正文长度 vs 后端落库正文长度（是否 ×2）
 *   3) 是否存在内容完全相同的两个 .cv-row.agent
 */
const { chromium } = require('playwright');
const Database = require('better-sqlite3');

const MSG = process.argv.slice(2).join(' ') || '帮我规划一下国庆后的工作';

(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const consoleErrors = [];
  p.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 160));
  });
  await p.addInitScript(() => localStorage.setItem('seenDemo', '1'));
  await p.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('.nx-shell', { timeout: 20000 });
  await p.waitForTimeout(1200);

  await p.locator('.composer-input').first().fill(MSG);
  await p.keyboard.press('Enter');
  // 等流式结束：思考点消失且出现正文
  await p.waitForSelector('.cv-row.agent .cv-text', { timeout: 120000 });
  await p.waitForTimeout(6000);

  const rows = await p.locator('.cv-row.agent').count();
  const texts = await p.locator('.cv-row.agent .cv-text').allInnerTexts();
  console.log('助手消息条数 =', rows);
  texts.forEach((t, i) => console.log(`  [${i}] 长度=${t.length} 开头=${JSON.stringify(t.slice(0, 40))}`));

  const dup = texts.length > 1 && texts[0] === texts[1];
  console.log('相邻两条内容完全相同 =', dup);

  // 与数据库比对
  const db = new Database('data/chat.db', { readonly: true });
  const r = db
    .prepare("SELECT content, model FROM messages WHERE role='assistant' ORDER BY created_at DESC LIMIT 1")
    .get();
  console.log('数据库正文长度 =', r.content.length, '| model =', r.model);
  console.log('DOM 首条长度 =', texts[0] ? texts[0].length : 0);
  console.log(
    'DOM / DB 比值 =',
    texts[0] ? (texts[0].length / Math.max(1, r.content.length)).toFixed(2) : 'n/a'
  );
  console.log('console errors =', consoleErrors.length ? consoleErrors : '[]');

  await p.screenshot({ path: '_shots/dup-reply.png', fullPage: false });
  await b.close();
})();
