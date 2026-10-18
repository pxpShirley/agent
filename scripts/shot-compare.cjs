const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  await p.addInitScript(() => localStorage.setItem('seenDemo', '1'));
  await p.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
  await p.waitForTimeout(1200);
  await p.screenshot({ path: '_shots/cmp_app.png' });

  const info = await p.evaluate(() => {
    const cs = (el) => (el ? getComputedStyle(el) : null);
    const body = cs(document.body);
    const scope = document.querySelector('.nx-shell') || document.querySelector('.scene') || document.querySelector('#root > div');
    const s = cs(scope);
    return {
      rootClass: document.documentElement.className,
      bodyBg: body && body.backgroundColor,
      bodyFilter: body && body.filter,
      bodyOpacity: body && body.opacity,
      scopeTag: scope && (scope.className || scope.tagName),
      scopeBg: s && s.backgroundColor,
      opacity: s && s.opacity,
    };
  });
  console.log(JSON.stringify(info, null, 2));

  // 原型
  const p2 = await b.newPage({ viewport: { width: 1440, height: 900 } });
  await p2.goto('file:///' + path.join(__dirname, '../prototype/xinglan-prototype.html').replace(/\\/g, '/'), {
    waitUntil: 'load',
  });
  await p2.waitForTimeout(1200);
  await p2.screenshot({ path: '_shots/cmp_proto.png' });

  await b.close();
})();
