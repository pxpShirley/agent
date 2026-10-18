const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });
  p.on('pageerror', (e) => errs.push('PAGEERROR: ' + String(e).slice(0, 200)));
  await p.addInitScript(() => localStorage.setItem('seenDemo', '1'));
  try {
    await p.goto('http://localhost:5173/', { waitUntil: 'networkidle', timeout: 15000 });
    await p.waitForTimeout(1500);
    const info = await p.evaluate(() => ({
      rootChildren: document.getElementById('root')?.children.length ?? -1,
      bodyText: (document.body.innerText || '').slice(0, 120),
      hasShell: !!document.querySelector('.nx-shell'),
    }));
    console.log('DOM', JSON.stringify(info));
  } catch (e) {
    console.log('GOTO_FAIL', String(e).slice(0, 200));
  }
  console.log('ERRORS', errs.length ? JSON.stringify(errs.slice(0, 6), null, 1) : 'none');
  await b.close();
})();
