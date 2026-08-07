/**
 * apps/ai_rag_database_routing/src/search.ts
 *
 * 网页搜索兜底(无相关数据库命中时使用),四层降级(符合多层容错偏好):
 *   1. SERPAPI_KEY 存在 → SerpAPI Google 搜索
 *   2. Bing(cn.bing.com,免费,国内网络通常可达)
 *   3. DuckDuckGo HTML(免费,部分网络环境被阻断)
 *   4. 全部失败 → 返回提示文本,由 LLM 基于通用知识回答
 *
 * 每层 try/catch + 8s 超时 + User-Agent,任何一层失败不影响主流程。
 */
export interface SearchResult {
  title: string;
  snippet: string;
  url?: string;
}

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

/** 带 1 次重试 + 8s 超时 + User-Agent 的 fetch */
async function fetchHtml(url: string, init: RequestInit = {}, retries = 1): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        ...init,
        headers: { 'User-Agent': BROWSER_UA, ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
      const msg = (err as Error).message || '';
      if (/HTTP 4\d\d/.test(msg)) throw err; // 4xx 不重试
    }
    if (attempt < retries) await sleep(400 * (attempt + 1));
  }
  throw lastErr instanceof Error ? lastErr : new Error('fetch failed');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function decodeEntities(s: string): string {
  return s
    .replace(/&ensp;|&emsp;|&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#\d+;/g, (m) => {
      const code = parseInt(m.slice(2, -1), 10);
      return isNaN(code) ? m : String.fromCharCode(code);
    });
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
}

// ─── 后端 1:SerpAPI ───────────────────────────────────────────────

async function searchSerpapi(query: string, apiKey: string, limit: number): Promise<SearchResult[]> {
  const url = new URL('https://serpapi.com/search');
  url.searchParams.set('engine', 'google');
  url.searchParams.set('q', query);
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('num', String(limit));
  const res = await fetch(url.toString(), {
    headers: { 'User-Agent': BROWSER_UA },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`SerpAPI HTTP ${res.status}`);
  const data = (await res.json()) as { organic_results?: Array<{ title?: string; snippet?: string; link?: string }> };
  return (data.organic_results ?? [])
    .slice(0, limit)
    .map((r) => ({ title: r.title ?? '(无标题)', snippet: r.snippet ?? '', url: r.link }));
}

// ─── 后端 2:Bing(国内可达)────────────────────────────────────────

async function searchBing(query: string, limit: number): Promise<SearchResult[]> {
  const url = new URL('https://cn.bing.com/search');
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(limit));
  const html = await fetchHtml(url.toString());

  const results: SearchResult[] = [];
  const blockRe = /<li class="b_algo"[\s\S]*?<\/li>/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(html)) !== null && results.length < limit) {
    const block = m[0];
    const h2 = block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/);
    if (!h2) continue;
    const href = h2[1].match(/href="([^"]+)"/);
    const title = stripTags(h2[1]);
    if (!title) continue;
    const p = block.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    results.push({ title, snippet: p ? stripTags(p[1]) : '', url: href ? decodeEntities(href[1]) : undefined });
  }
  if (results.length === 0) throw new Error('Bing 未解析到结果');
  return results;
}

// ─── 后端 3:DuckDuckGo HTML ───────────────────────────────────────

async function searchDuckDuckGo(query: string, limit: number): Promise<SearchResult[]> {
  const url = new URL('https://html.duckduckgo.com/html/');
  const html = await fetchHtml(url.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `q=${encodeURIComponent(query)}`,
  });

  const results: SearchResult[] = [];
  const blockRe =
    /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(html)) && results.length < limit) {
    const title = stripTags(m[2]);
    const snippet = stripTags(m[3]);
    if (title) results.push({ title, snippet, url: decodeDdgRedirect(m[1]) });
  }
  if (results.length === 0) throw new Error('DuckDuckGo 未解析到结果');
  return results;
}

function decodeDdgRedirect(url: string): string | undefined {
  try {
    const u = new URL(url.startsWith('//') ? `https:${url}` : url);
    const uddg = u.searchParams.get('uddg');
    return uddg ? decodeURIComponent(uddg) : url;
  } catch {
    return url;
  }
}

// ─── 汇总为文本(供 LLM 作为上下文)────────────────────────────────

function formatResults(query: string, results: SearchResult[], source: string): string {
  const lines = [`[搜索来源: ${source}] 查询: "${query}"`, `共 ${results.length} 条结果:`, ''];
  results.forEach((r, i) => {
    lines.push(`${i + 1}. ${r.title}`);
    if (r.snippet) lines.push(`   ${r.snippet}`);
    if (r.url) lines.push(`   链接: ${r.url}`);
    lines.push('');
  });
  return lines.join('\n');
}

/**
 * 网页搜索主入口:四层降级,始终返回一段可用文本(搜索失败时返回提示,
 * 由 LLM 基于通用知识回答)。供 /api/query 的网页兜底阶段调用。
 */
export async function searchWeb(
  query: string,
  options: { serpapiKey?: string; limit?: number } = {},
): Promise<{ text: string; source: string }> {
  const limit = options.limit || 5;

  // 1) SerpAPI
  if (options.serpapiKey) {
    try {
      const results = await searchSerpapi(query, options.serpapiKey, limit);
      return { text: formatResults(query, results, 'SerpAPI'), source: 'serpapi' };
    } catch (err) {
      console.warn(`[searchWeb] SerpAPI 失败,降级到 Bing:`, (err as Error).message);
    }
  }

  // 2) Bing(国内通常可达)
  try {
    const results = await searchBing(query, limit);
    return { text: formatResults(query, results, 'Bing'), source: 'bing' };
  } catch (err) {
    console.warn(`[searchWeb] Bing 失败,降级到 DuckDuckGo:`, (err as Error).message);
  }

  // 3) DuckDuckGo
  try {
    const results = await searchDuckDuckGo(query, limit);
    return { text: formatResults(query, results, 'DuckDuckGo'), source: 'duckduckgo' };
  } catch (err) {
    console.warn(`[searchWeb] DuckDuckGo 失败,使用通用知识兜底:`, (err as Error).message);
  }

  // 4) 兜底:提示 LLM 基于通用知识回答
  return {
    text: '[搜索不可用] 未能获取到网络结果。请基于你的通用知识直接回答该问题,并注明信息来源不确定。',
    source: 'fallback',
  };
}
