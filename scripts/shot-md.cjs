const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  await p.addInitScript(() => localStorage.setItem('seenDemo', '1'));
  await p.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('.nx-shell', { timeout: 20000 });
  await p.waitForTimeout(800);

  await p.locator('.composer-input').first().fill('帮我规划周末周边游');
  await p.keyboard.press('Enter');
  await p.waitForTimeout(20000);

  const info = await p.evaluate(() => {
    const el = document.querySelector('.cv-row.agent .cv-md');
    return {
      html: el ? el.innerHTML.slice(0, 1500) : null,
      text: el ? el.textContent.slice(0, 600) : null,
    };
  });
  console.log('=== rendered HTML (first 1500) ===');
  console.log(info.html);
  console.log('=== rendered TEXT (first 600) ===');
  console.log(info.text);

  const card = await p.$('.cv-row.agent');
  if (card) await card.screenshot({ path: '_shots/md_card.png' });
  await b.close();
})();
