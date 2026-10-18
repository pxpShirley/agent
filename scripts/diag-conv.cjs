const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  await p.addInitScript(() => localStorage.setItem('seenDemo', '1'));
  await p.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('.nx-shell', { timeout: 20000 });
  await p.waitForTimeout(1000);

  // —— 改动二：欢迎页不应出现"常用对话" chips（SuggestionChips .nx-chips / .composer-chips）——
  const welcome = await p.evaluate(() => {
    const vis = (sel) => [...document.querySelectorAll(sel)].filter((e) => e.offsetParent !== null).length;
    return {
      nxChips: vis('.nx-chips'),        // SuggestionChips 容器
      composerChips: vis('.composer-chips'),
      welcomeSub: (document.querySelector('.nx-welcome-sub')?.textContent || '').trim(),
    };
  });
  console.log('WELCOME:', JSON.stringify(welcome));

  await p.screenshot({ path: '_shots/conv_welcome.png' });

  await p.locator('.composer-input').first().fill('帮我规划周末周边游');
  await p.keyboard.press('Enter');
  // 等后端 15s 失败快退 + mock 兜底 + 流式打字（覆盖看门狗窗口）
  await p.waitForTimeout(20000);

  const r = await p.evaluate(() => {
    const vis = (sel) => [...document.querySelectorAll(sel)].filter((e) => e.offsetParent !== null).length;
    const txt = (sel) => { const el = document.querySelector(sel); return el ? el.textContent.trim() : null; };
    const agentText = document.querySelector('.cv-row.agent .cv-md');
    return {
      cv: document.querySelectorAll('.cv').length,
      cvRows: document.querySelectorAll('.cv-row').length,
      cvMe: document.querySelectorAll('.cv-row.me').length,
      cvAgent: document.querySelectorAll('.cv-row.agent').length,
      steps: document.querySelectorAll('.cv-step').length,
      artifacts: document.querySelectorAll('.cv-artifact').length,
      // 改动一：助手输出走 markdown 渲染
      cvMd: document.querySelectorAll('.cv-md').length,
      cvMdP: document.querySelectorAll('.cv-md p').length,
      cvMdUl: document.querySelectorAll('.cv-md ul').length,
      cvMdLi: document.querySelectorAll('.cv-md li').length,
      cvMdStrong: document.querySelectorAll('.cv-md strong').length,
      cvMdBlockquote: document.querySelectorAll('.cv-md blockquote').length,
      cvMdInnerSample: agentText ? agentText.innerHTML.slice(0, 200) : null,
      // 改动二：对话框上不应再有"常用对话" chips
      composerChips: vis('.composer-chips'),
      nxChips: vis('.nx-chips'),
      // 旧的"时间线/历史"必须彻底消失
      timelineLeft: document.querySelectorAll('.nx-tl').length,
      longtermLeft: document.querySelectorAll('.nx-tl-longterm').length,
      olderLeft: document.querySelectorAll('.nx-tl-older').length,
      histChatInConv: document.querySelectorAll('.nx-tl-ev.r-chat').length,
      notice: txt('.nx-inline-notice-text'),
      // 关键：刺眼的"引擎暂时不可用（模型调用失败），以上为本地兜底回复"不应再出现
      harshNotice: !!document.querySelector('.nx-inline-notice-text')?.textContent?.includes('引擎暂时不可用（模型调用失败）'),
      cvMdTextLen: (document.querySelector('.cv-md')?.textContent || '').trim().length,
    };
  });
  console.log(JSON.stringify(r, null, 1));
  await p.screenshot({ path: '_shots/conv_home.png' });
  await b.close();
})();
