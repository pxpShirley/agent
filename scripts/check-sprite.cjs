const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  await p.addInitScript(() => localStorage.setItem('seenDemo', '1'));
  await p.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
  await p.waitForTimeout(1200);
  const info = await p.evaluate(() => {
    const pick = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), opacity: cs.opacity, display: cs.display, visibility: cs.visibility };
    };
    return {
      sprite: pick('#mochiSvg') || pick('.star-sprite') || pick('.xc-core svg'),
      core: pick('.xc-core'),
      wrap: pick('.xc-wrap'),
      state: pick('.xc-state'),
      mood: pick('.rs2-mood'),
      svgCount: document.querySelectorAll('.nx-presence svg').length,
    };
  });
  console.log(JSON.stringify(info, null, 1));
  await p.screenshot({ path: '_shots/sprite_check.png' });
  await b.close();
})();
