/**
 * apps/ai_travel_agent/src/tools/search.ts
 *
 * 旅行搜索工具(agentpack Tool):四层降级,符合用户偏好的多层容错。
 *   1. SERPAPI_KEY 存在 → SerpAPI Google 搜索
 *   2. Bing(cn.bing.com,免费,国内网络通常可达)
 *   3. DuckDuckGo HTML(免费,部分网络环境被阻断)
 *   4. 内置旅游知识兜底(按 query 关键词返回通用建议)
 *
 * 容错细节:每层 try/catch + fetch 超时(8s,避免阻断层卡死)+ 1 次重试 + User-Agent。
 */
import type { Tool } from 'agentpack';

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
      // 超时/连接失败才重试;4xx 不重试
      const msg = (err as Error).message || '';
      if (/HTTP 4\d\d/.test(msg)) throw err;
    }
    if (attempt < retries) await sleep(400 * (attempt + 1));
  }
  throw lastErr instanceof Error ? lastErr : new Error('fetch failed');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 解码常见 HTML 实体 */
function decodeEntities(s: string): string {
  return s
    .replace(/&ensp;|&emsp;|&nbsp;/g, ' ')
    .replace(/&#0183;|&middot;|·/g, '·')
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
  // SerpAPI 用 JSON,不走 fetchHtml
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

// ─── 后端 2:Bing(cn.bing.com,国内可达)──────────────────────────────

async function searchBing(query: string, limit: number): Promise<SearchResult[]> {
  const url = new URL('https://cn.bing.com/search');
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(limit));
  const html = await fetchHtml(url.toString());

  const results: SearchResult[] = [];
  // 非贪婪匹配每个 b_algo 块
  const blockRe = /<li class="b_algo"[\s\S]*?<\/li>/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(html)) !== null && results.length < limit) {
    const block = m[0];
    // 标题与链接在 <h2><a href="...">title</a></h2>
    const h2 = block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/);
    if (!h2) continue;
    const href = h2[1].match(/href="([^"]+)"/);
    const title = stripTags(h2[1]);
    if (!title) continue;
    // 摘要:块内第一个 <p>...</p>
    const p = block.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    const snippet = p ? stripTags(p[1]) : '';
    results.push({ title, snippet, url: href ? decodeEntities(href[1]) : undefined });
  }
  if (results.length === 0) throw new Error('Bing 未解析到结果');
  return results;
}

// ─── 后端 3:DuckDuckGo HTML(免费,部分环境被阻断)──────────────────

async function searchDuckDuckGo(query: string, limit: number): Promise<SearchResult[]> {
  const url = new URL('https://html.duckduckgo.com/html/');
  const html = await fetchHtml(url.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `q=${encodeURIComponent(query)}`,
  });

  const results: SearchResult[] = [];
  const blockRe = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
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

// ─── 后端 4:内置旅游知识兜底 ─────────────────────────────────────

function searchFallback(query: string): SearchResult[] {
  const q = query.toLowerCase();
  const tips: SearchResult[] = [];

  const knowledge: Array<{ keywords: string[]; title: string; snippet: string }> = [
    { keywords: ['tokyo', '东京'], title: '东京旅行指南', snippet: '浅草寺、涩谷十字路口、秋叶原、新宿御苑;建议购买 Suica 交通卡。最佳季节 3-4 月樱花、11 月红叶。' },
    { keywords: ['kyoto', '京都'], title: '京都旅行指南', snippet: '伏见稻荷大社、清水寺、岚山竹林、金阁寺;建议穿和服体验祇园老街。' },
    { keywords: ['paris', '巴黎'], title: '巴黎旅行指南', snippet: '卢浮宫、埃菲尔铁塔、塞纳河游船、蒙马特高地;建议购买博物馆通票。' },
    { keywords: ['bangkok', '曼谷'], title: '曼谷旅行指南', snippet: '大皇宫、卧佛寺、湄南河夜游、考山路;注意寺庙着装要求。' },
    { keywords: ['new york', '纽约', 'nyc'], title: '纽约旅行指南', snippet: '中央公园、自由女神、时代广场、大都会博物馆;建议购买地铁无限次卡。' },
    { keywords: ['梅州', 'meizhou'], title: '梅州旅行指南', snippet: '客家文化之都:雁南飞茶田、叶剑英纪念园、围龙屋、客天下;建议品尝盐焗鸡、酿豆腐。' },
  ];

  for (const k of knowledge) {
    if (k.keywords.some((kw) => q.includes(kw))) tips.push({ title: k.title, snippet: k.snippet });
  }
  tips.push({ title: '通用旅行规划建议', snippet: '提前预订住宿与机票可节省 20-40%;下载离线地图与翻译 App;购买旅行保险;备份重要证件电子版。' });
  tips.push({ title: '行程安排原则', snippet: '每日 2-3 个主要景点为宜,留出弹性时间;上午博物馆/景点,下午街区漫步,傍晚观景用餐。' });
  return tips;
}

// ─── 汇总为文本 ───────────────────────────────────────────────────

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

// ─── 导出 agentpack Tool ──────────────────────────────────────────

export function createSearchTool(serpapiKey?: string): Tool {
  return {
    name: 'search_web',
    description:
      '搜索网络获取旅行相关信息(目的地活动、景点、住宿、交通、美食等)。' +
      '输入 query 搜索词,返回最相关的网页结果标题与摘要。当需要了解目的地真实信息时调用。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索词,如 "东京 7天 必去景点"' },
        limit: { type: 'number', description: '返回结果数量上限,默认 8' },
      },
      required: ['query'],
    },
    async execute(_toolCallId, args) {
      const { query, limit = 8 } = (args ?? {}) as { query?: string; limit?: number };
      if (!query) {
        return { content: [{ type: 'text', text: '错误:缺少 query 参数' }], details: { error: 'missing_query' } };
      }

      // 四层降级链:每层失败打印原因后继续
      // 1) SerpAPI
      if (serpapiKey) {
        try {
          const results = await searchSerpapi(query, serpapiKey, limit);
          return { content: [{ type: 'text', text: formatResults(query, results, 'SerpAPI') }], details: { source: 'serpapi', count: results.length } };
        } catch (err) {
          console.warn(`[search_web] SerpAPI 失败,降级到 Bing:`, (err as Error).message);
        }
      }

      // 2) Bing(国内通常可达)
      try {
        const results = await searchBing(query, limit);
        return { content: [{ type: 'text', text: formatResults(query, results, 'Bing') }], details: { source: 'bing', count: results.length } };
      } catch (err) {
        console.warn(`[search_web] Bing 失败,降级到 DuckDuckGo:`, (err as Error).message);
      }

      // 3) DuckDuckGo(部分环境被阻断)
      try {
        const results = await searchDuckDuckGo(query, limit);
        return { content: [{ type: 'text', text: formatResults(query, results, 'DuckDuckGo') }], details: { source: 'duckduckgo', count: results.length } };
      } catch (err) {
        console.warn(`[search_web] DuckDuckGo 失败,降级到内置兜底:`, (err as Error).message);
      }

      // 4) 内置兜底
      const results = searchFallback(query);
      return { content: [{ type: 'text', text: formatResults(query, results, '内置旅游知识(兜底)') }], details: { source: 'fallback', count: results.length } };
    },
  };
}

/** 供 config.ts 展示当前搜索后端链 */
export function describeSearchBackend(serpapiKey?: string): string {
  return serpapiKey ? 'serpapi' : 'bing+duckduckgo+fallback';
}
