const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  await p.addInitScript(() => localStorage.setItem('seenDemo', '1'));
  await p.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('.nx-shell', { timeout: 20000 });
  await p.waitForTimeout(1500);

  const labels = await p.locator('.nx-rail-btn').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
  console.log('rail labels =', JSON.stringify(labels));

  const count = async () => p.locator('.msg-agent, .msg-me, .nx-msg, .msg-row').count();
  console.log('initial msgs =', await count());

  await p.locator('.nx-rail-btn[aria-label="历史"]').click();
  await p.waitForTimeout(800);
  const first = p.locator('.hx-card').first();
  if (await first.count()) {
    await first.click();
    await p.waitForTimeout(1400);
    console.log('after OPEN session msgs =', await count());
  } else {
    console.log('no session card');
  }

  const newBtn = p.locator('.nx-new-chat-btn');
  console.log('newChat button exists =', await newBtn.count());
  if (await newBtn.count()) {
    await newBtn.click();
    await p.waitForTimeout(1000);
    console.log('after NEW CHAT msgs =', await count());
    console.log('welcome visible =', await p.locator('.nx-welcome').count());
  }
  await p.screenshot({ path: '_shots/newchat.png' });
  await b.close();
})();
