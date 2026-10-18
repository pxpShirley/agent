/**
 * 星澜 · 实时联网检索（web_lookup 后端）
 * 默认走 DuckDuckGo HTML 免 Key 抓取；可通过环境变量切换为 Brave / Tavily / SerpAPI（需对应 Key）。
 * 统一返回结构化结果，网络异常/超时优雅降级（不抛异常，error 字段说明）。
 *
 * 设计要点：
 * - 这是"真实联网"实现，面向可正常访问外网的部署环境；沙箱/内网若无外网会优雅降级。
 * - 所有请求带 8s 超时（AbortSignal.timeout），避免阻塞 agent 主循环。
 */
export interface WebResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebLookupResult {
  query: string;
  results: WebResult[];
  source: string;
  error?: string;
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const HTML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&quot;': '"',
  '&#x27;': "'",
  '&#39;': "'",
  '&lt;': '<',
  '&gt;': '>',
  '&nbsp;': ' ',
  '&hellip;': '…',
};

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&[a-z#0-9]+;/gi, (e) => HTML_ENTITIES[e.toLowerCase()] || e)
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeDdgUrl(href: string): string {
  try {
    const normalized = href.startsWith('//') ? 'https:' + href : href;
    const u = new URL(normalized, 'https://duckduckgo.com');
    const uddg = u.searchParams.get('uddg');
    if (uddg) return decodeURIComponent(uddg);
    return u.href;
  } catch {
    return href;
  }
}

async function ddgSearch(query: string, limit: number): Promise<WebLookupResult> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`DuckDuckGo 返回 ${res.status}`);
  const html = await res.text();

  const titles: Array<{ url: string; title: string }> = [];
  const titleRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = titleRe.exec(html))) {
    titles.push({ url: decodeDdgUrl(m[1]), title: stripHtml(m[2]) });
  }
  const snippets: string[] = [];
  const snipRe = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  while ((m = snipRe.exec(html))) {
    snippets.push(stripHtml(m[1]));
  }

  const results: WebResult[] = [];
  for (let i = 0; i < titles.length && results.length < limit; i++) {
    results.push({ title: titles[i].title, url: titles[i].url, snippet: snippets[i] || '' });
  }
  return { query, results, source: 'duckduckgo' };
}

async function braveSearch(query: string, limit: number): Promise<WebLookupResult> {
  const key = process.env.BRAVE_API_KEY;
  if (!key) throw new Error('未配置 BRAVE_API_KEY');
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(
    query
  )}&count=${limit}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'X-Subscription-Token': key },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Brave 返回 ${res.status}`);
  const data = await res.json();
  const web = (data as any)?.web?.results || [];
  const results: WebResult[] = web.slice(0, limit).map((r: any) => ({
    title: r.title,
    url: r.url,
    snippet: r.description || '',
  }));
  return { query, results, source: 'brave' };
}

async function tavilySearch(query: string, limit: number): Promise<WebLookupResult> {
  const key = process.env.TAVILY_API_KEY;
  if (!key) throw new Error('未配置 TAVILY_API_KEY');
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ query, max_results: limit, search_depth: 'basic' }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Tavily 返回 ${res.status}`);
  const data = await res.json();
  const results: WebResult[] = (data as any)?.results?.slice(0, limit).map((r: any) => ({
    title: r.title,
    url: r.url,
    snippet: r.content || '',
  })) || [];
  return { query, results, source: 'tavily' };
}

async function serpapiSearch(query: string, limit: number): Promise<WebLookupResult> {
  const key = process.env.SERPAPI_KEY;
  if (!key) throw new Error('未配置 SERPAPI_KEY');
  const url = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(
    query
  )}&num=${limit}&api_key=${key}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`SerpAPI 返回 ${res.status}`);
  const data = await res.json();
  const organic = (data as any)?.organic_results || [];
  const results: WebResult[] = organic.slice(0, limit).map((r: any) => ({
    title: r.title,
    url: r.link,
    snippet: r.snippet || '',
  }));
  return { query, results, source: 'serpapi' };
}

/**
 * 博查（BoCha）AI 搜索：国内源，延迟最低（实测 ~150ms）。
 * 文档：POST https://api.bochaai.com/v1/web-search，Authorization: Bearer <key>
 */
async function bochaSearch(query: string, limit: number): Promise<WebLookupResult> {
  const key = process.env.BOCHA_API_KEY;
  if (!key) throw new Error('未配置 BOCHA_API_KEY');
  const res = await fetch('https://api.bochaai.com/v1/web-search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ query, count: limit, summary: true }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`博查返回 ${res.status}`);
  const data = await res.json();
  // 返回结构做健壮兼容：data.webPages.value 为官方结构，其余为防御性兜底
  const list: any[] =
    (data as any)?.data?.webPages?.value ||
    (data as any)?.data?.webPages ||
    (data as any)?.webPages?.value ||
    (data as any)?.results ||
    [];
  const results: WebResult[] = list.slice(0, limit).map((r: any) => ({
    title: r.name || r.title || '',
    url: r.url || r.link || '',
    snippet: r.summary || r.snippet || r.content || '',
  }));
  if (!results.length) throw new Error('检索结果为空');
  return { query, results, source: 'bocha' };
}

/**
 * 联网检索是否已就绪（供 Tool 装配 / Prompt 能力清单共用，单一事实来源）。
 * 满足以下任一即视为可用：
 *  - 配置了任一检索源的 Key（TAVILY / BOCHA / BRAVE / SERPAPI）
 *  - WEB_SEARCH_PROVIDER=dashscope（走百炼 enable_search，复用 BAILIAN_API_KEY，免额外 Key）
 *  - WEB_SEARCH_PROVIDER=duckduckgo（免 Key 抓取，但国内网络常不可达）
 */
export function isWebSearchConfigured(): boolean {
  const p = (process.env.WEB_SEARCH_PROVIDER || '').toLowerCase();
  if (p === 'dashscope') return true; // 复用百炼 enable_search，免 Key
  if (p === 'duckduckgo') return true; // 免 Key 抓取（连通性取决于部署环境）
  if (p) return Boolean(pickProvider()); // 显式指定源：必须配了对应 Key 才算就绪
  // 未显式指定：任一搜索 Key 配了就自动启用（优先级见 resolveProvider）
  return Boolean(process.env.TAVILY_API_KEY || process.env.BOCHA_API_KEY || process.env.BRAVE_API_KEY || process.env.SERPAPI_KEY);
}

/** 按「已配置的 Key」挑选检索源：博查（国内最快）> Tavily > Brave > SerpAPI */
function pickProvider(): 'bocha' | 'tavily' | 'brave' | 'serpapi' | null {
  if (process.env.BOCHA_API_KEY) return 'bocha';
  if (process.env.TAVILY_API_KEY) return 'tavily';
  if (process.env.BRAVE_API_KEY) return 'brave';
  if (process.env.SERPAPI_KEY) return 'serpapi';
  return null;
}

/** 解析当前实际生效的检索源：显式 WEB_SEARCH_PROVIDER 优先，否则按已配 Key 自动选 */
function resolveProvider(): string {
  const explicit = (process.env.WEB_SEARCH_PROVIDER || '').toLowerCase();
  if (explicit) return explicit;
  return pickProvider() || 'duckduckgo';
}

/**
 * 走百炼（阿里云 DashScope）enable_search 的「免 Key」实时检索。
 * 不需要任何独立搜索 Key，复用 BAILIAN_API_KEY；返回模型基于联网结果整理的要点。
 * 注意：百炼 OpenAI 兼容模式在 enable_search 下不直接回传独立 URL，
 * 故将整段检索要点作为单条结构化结果返回（title 标注查询词，snippet 为要点正文）。
 */
async function dashscopeSearch(query: string, limit: number): Promise<WebLookupResult> {
  const key = process.env.BAILIAN_API_KEY;
  if (!key) throw new Error('未配置 BAILIAN_API_KEY（dashscope 检索需要）');
  const url =
    process.env.BAILIAN_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: process.env.BAILIAN_MODEL || 'qwen-plus',
      messages: [
        {
          role: 'system',
          content:
            '你是联网检索助手。基于实时联网检索结果，用简体中文给出与用户查询最相关的要点（每条一行，保留关键信息与数字），不要编造；若联网未返回有效信息请如实说明。',
        },
        { role: 'user', content: `请联网检索：${query}` },
      ],
      enable_search: true,
      stream: false,
      max_tokens: 400,
    }),
    // 与 ddg 一致的 8s 快速失败：enable_search 在部分账号/模型下会挂起，
    // 超时过长会吃掉整轮预算（叠加 bailian.ts 的自愈重试将翻倍至 30s+）。
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`DashScope 检索返回 ${res.status}`);
  const data = await res.json();
  const content = (data?.choices?.[0]?.message?.content || '').trim();
  if (!content) throw new Error('检索结果为空');
  const results: WebResult[] = [
    { title: `实时检索：${query}`, url: '', snippet: content.slice(0, 900) },
  ];
  return { query, results, source: 'dashscope' };
}

/**
 * 实时联网检索。query 为空直接返回空；其余一律 try/catch，网络异常落到 error 字段。
 * 默认 provider=duckduckgo（免 Key）；可用 WEB_SEARCH_PROVIDER 切换 brave/tavily/serpapi/dashscope。
 */
export async function webSearch(
  query: string,
  opts?: { limit?: number }
): Promise<WebLookupResult> {
  const q = (query || '').trim();
  if (!q) return { query: '', results: [], source: 'none', error: '空查询' };
  const provider = resolveProvider();
  const limit = Math.min(Math.max(opts?.limit ?? 5, 1), 10);
  try {
    switch (provider) {
      case 'brave':
        return await braveSearch(q, limit);
      case 'tavily':
        return await tavilySearch(q, limit);
      case 'serpapi':
        return await serpapiSearch(q, limit);
      case 'bocha':
        return await bochaSearch(q, limit);
      case 'dashscope':
        return await dashscopeSearch(q, limit);
      default:
        return await ddgSearch(q, limit);
    }
  } catch (e: any) {
    return { query: q, results: [], source: provider, error: e?.message || '网络请求失败' };
  }
}

/**
 * 联网能力自检：用一条极短查询实打一次当前生效的检索源，返回可用性 / 延迟 / 错误。
 * 用于设置页「联网自检」，配完 Key 立刻知道能不能用，不必靠一整轮对话试。
 */
export async function pingWebSearch(): Promise<{
  provider: string;
  configured: boolean;
  ok: boolean;
  latencyMs: number;
  error?: string;
  sample?: string;
}> {
  const provider = resolveProvider();
  const configured = isWebSearchConfigured();
  if (!configured) {
    return { provider, configured: false, ok: false, latencyMs: 0, error: '未配置任何检索源 Key（BOCHA / TAVILY / BRAVE / SERPAPI）' };
  }
  const started = Date.now();
  try {
    const r = await webSearch('今日天气', { limit: 1 });
    if (r.error) {
      return { provider, configured: true, ok: false, latencyMs: Date.now() - started, error: r.error };
    }
    return {
      provider,
      configured: true,
      ok: r.results.length > 0,
      latencyMs: Date.now() - started,
      error: r.results.length ? undefined : '检索返回空结果',
      sample: r.results[0]?.title,
    };
  } catch (e: any) {
    return { provider, configured: true, ok: false, latencyMs: Date.now() - started, error: e?.message || String(e) };
  }
}
