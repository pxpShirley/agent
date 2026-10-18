/**
 * 联网检索源可达性探测：不带 Key 直接打各家的公开端点，看 TCP/HTTP 是否通、耗时多少。
 * 用于回答「这台机器到底能接哪家搜索 API」，避免配了 Key 才发现网络不通。
 */
const TARGETS = [
  { name: 'duckduckgo (html)', url: 'https://html.duckduckgo.com/html/?q=test' },
  { name: 'brave', url: 'https://api.search.brave.com/res/v1/web/search?q=test&count=1' },
  { name: 'tavily', url: 'https://api.tavily.com/search', method: 'POST' },
  { name: 'serpapi', url: 'https://serpapi.com/search.json?engine=google&q=test' },
  { name: 'bocha 博查', url: 'https://api.bochaai.com/v1/web-search', method: 'POST' },
  { name: 'bing', url: 'https://www.bing.com/search?q=test' },
  { name: 'baidu', url: 'https://www.baidu.com/s?wd=test' },
];

for (const t of TARGETS) {
  const started = Date.now();
  try {
    const init = { signal: AbortSignal.timeout(8000) };
    const res =
      t.method === 'POST'
        ? await fetch(t.url, { ...init, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        : await fetch(t.url, init);
    const ms = Date.now() - started;
    console.log(
      `${res.ok ? '🟢' : '🟡'} ${t.name.padEnd(18)} HTTP ${res.status}  ${ms}ms`
    );
  } catch (e) {
    const ms = Date.now() - started;
    console.log(`🔴 ${t.name.padEnd(18)} ${(e?.message || '失败').slice(0, 60)}  ${ms}ms`);
  }
}
