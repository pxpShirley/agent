/* 交互升级验收：欢迎区去重 / 时刻感知条 / placeholder / 复制按钮 / 底部重叠 */
const { chromium } = require('playwright');

const wait = (p, ms) => p.waitForTimeout(ms);

(async () => {
  const browser = await chromium.launch();
  const out = {};

  // —— A. 真实态（seenDemo=1）：欢迎空态 ——
  const a = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await a.addInitScript(() => localStorage.setItem('seenDemo', '1'));
  await a.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
  await wait(a, 1200);

  out.welcome = await a.evaluate(() => {
    const sub = document.querySelector('.nx-welcome-sub');
    const bar = document.querySelector('.nx-moment-bar');
    const greetSub = document.querySelector('.nx-greet-sub');
    const ta = document.querySelector('.composer-input');
    return {
      welcomeSub: sub && sub.textContent.trim(),
      greetSub: greetSub && greetSub.textContent.trim(),
      momentBar: bar && bar.textContent.replace(/\s+/g, ' ').trim(),
      chipGroups: document.querySelectorAll('.nx-chips').length,
      composerChips: document.querySelectorAll('.composer-chips').length,
      placeholder: ta && ta.placeholder,
      subContainsDate: !!(sub && greetSub && sub.textContent.includes(greetSub.textContent.split(' · ')[0])),
    };
  });
  await a.screenshot({ path: '_shots/ix-01-welcome.png' });

  // —— B. 演示态：有消息 → 复制按钮悬停 ——
  const b = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await b.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
  await wait(b, 3500); // 等演示脚本推进出若干条消息
  const msgCount = await b.locator('.msg-col').count();
  let copy = { found: 0, before: null, after: null, clicked: null };
  if (msgCount > 0) {
    const col = b.locator('.msg-col').last();
    await col.scrollIntoViewIfNeeded();
    const btn = col.locator('.msg-copy').first();
    copy.found = await b.locator('.msg-col .msg-copy').count();
    if (await btn.count()) {
      copy.before = await btn.evaluate((el) => getComputedStyle(el).opacity);
      await col.hover();
      await wait(b, 400);
      copy.after = await btn.evaluate((el) => getComputedStyle(el).opacity);
      await btn.click();
      await wait(b, 300);
      copy.clicked = await btn.evaluate((el) => ({ text: el.textContent.trim(), cls: el.className }));
    }
  }
  out.copy = { msgCount, ...copy };
  await b.screenshot({ path: '_shots/ix-02-copy-hover.png' });

  // —— C. 底部重叠复检 ——
  const overlaps = await b.evaluate(() => {
    const els = [...document.querySelectorAll('.nx-presence *')].filter((el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.height > 0 && r.top > window.innerHeight - 160 && cs.visibility !== 'hidden' && el.children.length === 0 && el.textContent.trim();
    });
    const out = [];
    for (let i = 0; i < els.length; i++) {
      for (let j = i + 1; j < els.length; j++) {
        const x = els[i].getBoundingClientRect(), y = els[j].getBoundingClientRect();
        const ox = Math.min(x.right, y.right) - Math.max(x.left, y.left);
        const oy = Math.min(x.bottom, y.bottom) - Math.max(x.top, y.top);
        if (ox > 8 && oy > 8) out.push({ a: els[i].className, b: els[j].className });
      }
    }
    return out.slice(0, 10);
  });
  out.overlaps = overlaps;

  console.log(JSON.stringify(out, null, 2));
  await browser.close();
})();
