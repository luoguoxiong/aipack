/**
 * apps/ai_blog_to_podcast_agent/src/tools/scrape.ts
 *
 * 博客抓取工具(aipack Tool):三层降级,符合用户偏好的多层容错。
 *   1. FIRECRAWL_API_KEY 存在 → Firecrawl v2 /scrape(返回 markdown 正文)
 *   2. 原生 fetch + HTML 正文提取(去 script/style/nav,取 main/article/p 文本)
 *   3. 兜底(返回 URL + 提示,让 LLM 基于已知处理)
 *
 * 容错细节:每层 try/catch + fetch 超时(8s,避免阻断层卡死)+ 1 次重试 + User-Agent。
 * 模式对齐 ai_travel_agent/src/tools/search.ts。
 */
import type { Tool } from '@aipack-ai/agent';

export interface ScrapeResult {
  url: string;
  title?: string;
  content: string; // markdown 或纯文本
  source: 'firecrawl' | 'fetch' | 'fallback';
  truncated: boolean;
}

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

/** 截断到合理长度,避免撑爆上下文 */
const MAX_CONTENT_CHARS = 20000;

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

function truncate(s: string, max: number): { truncated: boolean; text: string } {
  if (s.length <= max) return { truncated: false, text: s };
  return { truncated: true, text: s.slice(0, max) + '\n\n[...内容已截断...]' };
}

// ─── 后端 1:Firecrawl v2 /scrape ─────────────────────────────────

async function scrapeFirecrawl(url: string, apiKey: string): Promise<ScrapeResult> {
  const res = await fetch('https://api.firecrawl.dev/v2/scrape', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      url,
      formats: ['markdown'],
      onlyMainContent: true, // Firecrawl 自动去 nav/footer/script
    }),
    signal: AbortSignal.timeout(20000), // Firecrawl 较慢,给 20s
  });
  if (!res.ok) throw new Error(`Firecrawl HTTP ${res.status}`);
  const data = (await res.json()) as {
    data?: { markdown?: string; html?: string; metadata?: { title?: string } };
  };
  const markdown = data.data?.markdown;
  if (!markdown || !markdown.trim()) throw new Error('Firecrawl 返回空 markdown');
  const { truncated, text } = truncate(markdown, MAX_CONTENT_CHARS);
  return {
    url,
    title: data.data?.metadata?.title,
    content: text,
    source: 'firecrawl',
    truncated,
  };
}

// ─── 后端 2:原生 fetch + HTML 正文提取 ──────────────────────────

async function scrapeFetch(url: string): Promise<ScrapeResult> {
  const html = await fetchHtml(url);
  const { title, text } = extractMainContent(html);
  if (!text.trim()) throw new Error('HTML 解析为空');
  const { truncated, text: t } = truncate(text, MAX_CONTENT_CHARS);
  return { url, title, content: t, source: 'fetch', truncated };
}

/**
 * 零依赖 HTML 正文提取:去 script/style/nav/header/footer/aside,
 * 优先取 main/article,否则取整个 body;再提取 p/h/li/blockquote/pre 文本。
 */
function extractMainContent(html: string): { title: string; text: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1].trim()) : '';
  let body = html;
  // 剥离噪声标签
  body = body
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '');
  // 优先 main / article
  const mainMatch = body.match(/<(?:main|article)[\s\S]*?<\/(?:main|article)>/i);
  const region = mainMatch ? mainMatch[0] : body;
  // 提取所有正文块,丢弃短噪声
  const blocks: string[] = [];
  const blockRe = /<(?:p|h[1-6]|li|blockquote|pre)[^>]*>([\s\S]*?)<\/(?:p|h[1-6]|li|blockquote|pre)>/gi;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(region)) !== null) {
    const t = stripTags(m[1]);
    if (t.length > 20) blocks.push(t);
  }
  const text = blocks.join('\n\n');
  return { title, text };
}

// ─── 后端 3:兜底(返回 URL + 提示,让 LLM 自行处理)─────────────

function scrapeFallback(url: string): ScrapeResult {
  return {
    url,
    content: `[抓取失败] 无法获取 ${url} 的正文。请基于 URL 与你的已知信息生成播客摘要,或在摘要中说明无法抓取该博客。`,
    source: 'fallback',
    truncated: false,
  };
}

// ─── 汇总为文本 ───────────────────────────────────────────────────

function formatScrape(r: ScrapeResult): string {
  return [
    `[抓取来源: ${r.source}] URL: ${r.url}`,
    r.title ? `标题: ${r.title}` : '',
    r.truncated ? '(正文已截断)' : '',
    '',
    '正文:',
    r.content,
  ]
    .filter(Boolean)
    .join('\n');
}

// ─── 导出 aipack Tool ──────────────────────────────────────────

export function createScrapeTool(firecrawlKey?: string): Tool {
  return {
    name: 'scrape_blog',
    description:
      '抓取博客 URL 的正文内容。输入 url,返回博客标题与正文(markdown 或纯文本,已截断到合理长度)。' +
      '当用户给出博客链接需要读取正文时调用此工具。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '博客 URL,如 "https://example.com/blog/post"' },
      },
      required: ['url'],
    },
    async execute(_toolCallId, args) {
      const { url } = (args ?? {}) as { url?: string };
      if (!url) {
        return { content: [{ type: 'text', text: '错误:缺少 url 参数' }], details: { error: 'missing_url' } };
      }

      // 三层降级链:每层失败打印原因后继续
      // 1) Firecrawl
      if (firecrawlKey) {
        try {
          const r = await scrapeFirecrawl(url, firecrawlKey);
          return { content: [{ type: 'text', text: formatScrape(r) }], details: { source: r.source, truncated: r.truncated } };
        } catch (err) {
          console.warn(`[scrape_blog] Firecrawl 失败,降级到原生 fetch:`, (err as Error).message);
        }
      }

      // 2) 原生 fetch + HTML 正文提取
      try {
        const r = await scrapeFetch(url);
        return { content: [{ type: 'text', text: formatScrape(r) }], details: { source: r.source, truncated: r.truncated } };
      } catch (err) {
        console.warn(`[scrape_blog] 原生 fetch 失败,降级到兜底:`, (err as Error).message);
      }

      // 3) 兜底
      const r = scrapeFallback(url);
      return { content: [{ type: 'text', text: formatScrape(r) }], details: { source: 'fallback' } };
    },
  };
}

/** 供 config.ts 展示当前抓取后端链 */
export function describeScrapeBackend(firecrawlKey?: string): string {
  return firecrawlKey ? 'firecrawl+fetch+fallback' : 'fetch+fallback';
}
