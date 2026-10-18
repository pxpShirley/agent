const { chromium } = require('playwright');

(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const pageErrors = [];
  const consoleErrors = [];
  p.on('pageerror', (e) => pageErrors.push(String(e && e.message)));
  p.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

  await p.addInitScript(() => localStorage.setItem('seenDemo', '1'));
  await p.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('.nx-shell', { timeout: 20000 });
  await p.waitForTimeout(800);

  const msg = '用一句话介绍杭州西湖';
  await p.locator('.composer-input').first().fill(msg);
  await p.keyboard.press('Enter');

  const t0 = Date.now();
  let text = '';
  for (let i = 0; i < 120; i++) {
    await p.waitForTimeout(500);
    text = await p.evaluate(() => {
      const el = document.querySelector('.cv-row.agent .cv-md');
      return el ? (el.textContent || '').trim() : '';
    });
    if (text.length > 20) break;
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1) + 's';

  const info = await p.evaluate(() => {
    const el = document.querySelector('.cv-row.agent .cv-md');
    const notices = Array.from(document.querySelectorAll('[class*="notice"]'))
      .map((n) => (n.textContent || '').trim())
      .filter(Boolean);
    return {
      hasMd: !!el,
      textLen: el ? (el.textContent || '').trim().length : 0,
      preview: el ? (el.textContent || '').trim().slice(0, 200) : null,
      mdP: document.querySelectorAll('.cv-row.agent .cv-md p').length,
      mdStrong: document.querySelectorAll('.cv-row.agent .cv-md strong').length,
      notices,
      bodyHasEngineFail: /真实引擎调用失败|引擎暂时不可用/.test(document.body.innerText || ''),
    };
  });

  console.log(JSON.stringify({ elapsed, ...info, pageErrors, consoleErrors: consoleErrors.slice(0, 5) }, null, 2));
  await p.screenshot({ path: '_shots/verify_real_engine.png' });
  await b.close();
})();
