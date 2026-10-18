/* 三个菜单页截图：我的 / 历史 / 治理 */
const { chromium } = require('playwright');
const wait = (p, ms) => p.waitForTimeout(ms);

(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  await p.addInitScript(() => localStorage.setItem('seenDemo', '1'));
  await p.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
  await wait(p, 1500);

  const open = async (label, file) => {
    await p.locator('.nx-rail-btn', { hasText: label }).first().click();
    await wait(p, 900);
    await p.screenshot({ path: `_shots/${file}` });
    const info = await p.evaluate(() => {
      const v = document.querySelector('.nx-side-view.on');
      if (!v) return null;
      const heads = [...v.querySelectorAll('.nx-sv-title, .dash-header h2, .gv-head h2, .new-chat-btn, .nx-new-chat-btn')]
        .map((e) => e.textContent.trim()).slice(0, 8);
      return { aria: v.getAttribute('aria-label'), heads };
    });
    return info;
  };

  const out = {};
  out.dashboard = await open('我的', 'menu-01-dash.png');
  out.history = await open('历史', 'menu-02-hist.png');
  out.governance = await open('治理', 'menu-03-gov.png');
  console.log(JSON.stringify(out, null, 2));
  await b.close();
})();
