const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  await p.addInitScript(() => localStorage.setItem('seenDemo', '1'));
  await p.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
  await p.waitForTimeout(1000);

  const overlaps = await p.evaluate(() => {
    // 取 presence 区域底部 120px 内的所有可见文本元素，检测两两重叠
    const els = [...document.querySelectorAll('.nx-presence *')].filter((el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.height > 0 && r.top > window.innerHeight - 160 && cs.visibility !== 'hidden' && el.children.length === 0 && el.textContent.trim();
    });
    const out = [];
    for (let i = 0; i < els.length; i++) {
      for (let j = i + 1; j < els.length; j++) {
        const a = els[i].getBoundingClientRect(), c = els[j].getBoundingClientRect();
        const ox = Math.min(a.right, c.right) - Math.max(a.left, c.left);
        const oy = Math.min(a.bottom, c.bottom) - Math.max(a.top, c.top);
        if (ox > 8 && oy > 8) {
          out.push({
            a: els[i].className + '|' + els[i].textContent.trim().slice(0, 6),
            b: els[j].className + '|' + els[j].textContent.trim().slice(0, 6),
          });
        }
      }
    }
    return out.slice(0, 10);
  });
  console.log(JSON.stringify(overlaps, null, 1));
  await b.close();
})();
