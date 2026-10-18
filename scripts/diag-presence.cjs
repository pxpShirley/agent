const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  await p.addInitScript(() => localStorage.setItem('seenDemo', '1'));
  await p.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('.nx-shell', { timeout: 20000 });
  await p.waitForTimeout(1500);

  const probe = async (label) => {
    const r = await p.evaluate(() => ({
      presence: document.querySelectorAll('.nx-presence').length,
      wide: !!document.querySelector('.nx-stage-body.wide'),
      cols: getComputedStyle(document.querySelector('.nx-stage-body')).gridTemplateColumns,
    }));
    console.log(label, JSON.stringify(r));
  };

  await probe('此刻 :');
  console.log('  older-toggle =', await p.locator('.nx-tl-older').count(), '| fresh =', await p.locator('.nx-tl-fresh').count());

  await p.locator('.nx-rail-btn[aria-label="我的"]').click();
  await p.waitForTimeout(700);
  await probe('我的 :');
  await p.screenshot({ path: '_shots/fix_mine.png' });

  await p.locator('.nx-rail-btn[aria-label="治理"]').click();
  await p.waitForTimeout(700);
  await probe('治理 :');
  await p.screenshot({ path: '_shots/fix_gov.png' });

  await p.locator('.nx-rail-btn[aria-label="此刻"]').click();
  await p.waitForTimeout(700);
  await probe('回此刻:');
  const older = p.locator('.nx-tl-older');
  if (await older.count()) {
    console.log('  toggle text =', (await older.textContent()).trim());
    await older.click();
    await p.waitForTimeout(500);
    console.log('  after expand chat-events =', await p.locator('.nx-tl-ev.r-chat').count());
  }
  await p.screenshot({ path: '_shots/fix_home.png' });
  await b.close();
})();
