const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  await p.addInitScript(() => localStorage.setItem('seenDemo', '1'));
  await p.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
  await p.waitForTimeout(1000);

  const shot = async (name) => p.screenshot({ path: `_shots/v2_${name}.png` });

  await shot('home');

  // 我的 · 灵境
  await p.locator('.nx-rail-btn[aria-label="我的"]').click();
  await p.waitForTimeout(700);
  await shot('dash');
  console.log('DASH cards=' + (await p.locator('.stat-card').count()) + ' iconwrap=' + (await p.locator('.icon-wrap').count()));

  // 历史
  await p.locator('.nx-rail-btn[aria-label="历史"]').click();
  await p.waitForTimeout(700);
  await shot('history');
  console.log('HIST delBtnsPerCard=' + (await p.locator('.hx-card').first().locator('.del-btn').count().catch(() => -1)));

  // 治理
  await p.locator('.nx-rail-btn[aria-label="治理"]').click();
  await p.waitForTimeout(700);
  await shot('gov');
  console.log('GOV overview=' + (await p.locator('.gv-overview').count()));

  // ⌘K
  await p.keyboard.press('Escape');
  await p.waitForTimeout(300);
  await p.keyboard.press('Control+k');
  await p.waitForTimeout(400);
  await p.keyboard.type('周末');
  await p.waitForTimeout(500);
  await shot('cmdk');
  console.log('CMDK items=' + (await p.locator('.cmdk-item').count()) + ' free=' + (await p.locator('.cmdk-item.free').count()));

  await b.close();
})();
