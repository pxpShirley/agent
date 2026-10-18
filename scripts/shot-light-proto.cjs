/* 光态原型分状态截图 */
const { chromium } = require('playwright');
const path = require('path');
const wait = (p, ms) => p.waitForTimeout(ms);

(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 900, height: 760 }, deviceScaleFactor: 2 });
  const url = 'file:///' + path.join(__dirname, '../prototype/qiguang-light.html').replace(/\\/g, '/');
  await p.goto(url, { waitUntil: 'load' });
  await wait(p, 800);

  await p.screenshot({ path: '_shots/light-00-full.png', fullPage: true });

  const shot = async (state, file, ms = 900) => {
    await p.click(`button.st[data-go="${state}"]`);
    await wait(p, ms);
    await p.locator('.stage').screenshot({ path: `_shots/${file}` });
  };

  await shot('calm', 'light-01-calm.png');
  await shot('thinking', 'light-02-thinking.png');
  await shot('speaking', 'light-03-speaking.png');
  await shot('waiting', 'light-04-waiting.png');
  await shot('away', 'light-05-away.png', 1500);
  await wait(p, 2200);
  await p.locator('.stage').screenshot({ path: '_shots/light-06-back.png' });

  console.log('ok');
  await b.close();
})();
