const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  await p.addInitScript(() => localStorage.setItem('seenDemo', '1'));
  await p.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('.nx-shell', { timeout: 20000 });
  await p.waitForTimeout(1200);

  // 触发「行程」分支：既有执行情况（多步）又有执行结果（行程卡产物）
  await p.locator('.composer-input').first().fill('帮我规划周末周边游');
  await p.keyboard.press('Enter');
  // 等待看门狗（引擎卡死 6s 切本地兜底）+ 步骤流 + 产物收尾
  await p.waitForTimeout(11000);

  const r = await p.evaluate(() => {
    const txt = (sel) => { const el = document.querySelector(sel); return el ? el.textContent.trim() : null; };
    const olderBtns = [...document.querySelectorAll('.nx-tl-older')].map((b) => b.textContent.trim());
    const workVisible = [...document.querySelectorAll('.nx-tl-ev.r-work')].filter((e) => e.offsetParent !== null).length;
    return {
      timeline: document.querySelectorAll('.nx-tl').length,
      // 主线：当前对话
      me: document.querySelectorAll('.nx-tl-ev.r-me').length,
      agent: document.querySelectorAll('.nx-tl-ev.r-agent').length,
      // 执行情况 / 执行结果
      steps: document.querySelectorAll('.nx-tl-step').length,
      stepHeaders: document.querySelectorAll('.nx-tl-steps-h').length,
      artifacts: document.querySelectorAll('.nx-tl-artifact').length,
      resHeaders: document.querySelectorAll('.nx-tl-res-h').length,
      // 历史是否还淹着主线
      longtermSections: document.querySelectorAll('.nx-tl-longterm').length,
      olderBtns,
      workVisible, // 折叠时应 = 0
      notice: txt('.nx-inline-notice-text'),
    };
  });
  console.log(JSON.stringify(r, null, 1));
  await p.screenshot({ path: '_shots/now_home.png' });
  await b.close();
})();
