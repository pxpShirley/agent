/* 真机验证：栖光光态接入主程序后的四种形态 */
const { chromium } = require('playwright');
const wait = (p, ms) => p.waitForTimeout(ms);

(async () => {
  const b = await chromium.launch();
  const out = {};

  // A. 静候（空态，无对话）
  const a = await b.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  await a.addInitScript(() => localStorage.setItem('seenDemo', '1'));
  await a.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
  await wait(a, 1500);
  out.calm = await a.evaluate(() => {
    const l = document.querySelector('.xl-light');
    const s = document.querySelector('.star-sprite');
    return {
      lightMounted: !!l,
      phase: l && l.dataset.phase,
      oldSpriteGone: !s,
      moodPaletteVisible: !!document.querySelector('.nx-presence-mood'),
    };
  });
  await a.locator('.nx-presence').screenshot({ path: '_shots/core-01-calm.png' });
  await a.close();

  // B. 演示流：抓 thinking / speaking / waiting
  const p = await b.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  await p.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
  const seen = {};
  for (let i = 0; i < 40; i++) {
    const ph = await p.evaluate(() => {
      const l = document.querySelector('.xl-light');
      return l ? l.dataset.phase : null;
    });
    if (ph && !seen[ph]) {
      seen[ph] = true;
      await wait(p, 220);
      await p.locator('.nx-presence').screenshot({ path: `_shots/core-${ph}.png` });
    }
    if (seen.thinking && seen.speaking && seen.waiting) break;
    await wait(p, 300);
  }
  out.phasesSeen = Object.keys(seen);
  console.log(JSON.stringify(out, null, 2));
  await b.close();
})();
