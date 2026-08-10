/**
 * apps/ai_teaching_agent_team/src/tools/search.ts
 *
 * 教学搜索工具(aipack Tool):四层降级,符合用户偏好的多层容错。
 *   1. SERPAPI_KEY 存在 → SerpAPI Google 搜索
 *   2. Bing(cn.bing.com,免费,国内网络通常可达)
 *   3. DuckDuckGo HTML(免费,部分网络环境被阻断)
 *   4. 内置教育知识兜底(按 query 关键词返回通用学习建议)
 *
 * 容错细节:每层 try/catch + fetch 超时(8s,避免阻断层卡死)+ 1 次重试 + User-Agent。
 * 模式对齐 apps/ai_travel_agent/src/tools/search.ts(搜索后端通用,兜底知识库改为教育主题)。
 */
import type { Tool } from '@aipack/agent';

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

// ─── 后端 4:内置教育知识兜底 ─────────────────────────────────────

function searchFallback(query: string): SearchResult[] {
  const q = query.toLowerCase();
  const tips: SearchResult[] = [];

  const knowledge: Array<{ keywords: string[]; title: string; snippet: string }> = [
    { keywords: ['python', 'python3'], title: 'Python 学习指南', snippet: '官方教程 docs.python.org/3/tutorial/;《Automate the Boring Stuff》适合入门;进阶看《Fluent Python》。建议边学边做小项目(爬虫、数据分析)。' },
    { keywords: ['machine learning', '机器学习', 'ml '], title: '机器学习学习指南', snippet: '吴恩达 Coursera 课入门;《动手学深度学习》(d2l.ai)理论+代码;scikit-learn 文档做经典算法;Kaggle 实战。' },
    { keywords: ['deep learning', '深度学习'], title: '深度学习学习指南', snippet: '《深度学习》(花书)打基础;PyTorch 官方教程;Transformer 看《Attention Is All You Need》+ The Annotated Transformer。' },
    { keywords: ['javascript', 'js ', 'node'], title: 'JavaScript 学习指南', snippet: 'MDN Web Docs 是最权威参考;《You Don\'t Know JS》深入机制;Node.js 看 nodejs.org 官方文档;做项目强化异步与模块。' },
    { keywords: ['react', '前端'], title: 'React 学习指南', snippet: 'react.dev 官方文档(新版)最佳入门;理解组件、props、state、hooks(useEffect/useState);配合 Vite 做小应用。' },
    { keywords: ['blockchain', '区块链'], title: '区块链学习指南', snippet: '先理解哈希、非对称加密、Merkle 树;Bitcoin 白皮书 + 以太坊黄皮书;Solidity 官方文档写合约;Foundry/Hardhat 实战。' },
    { keywords: ['algorithm', '算法', '排序', 'sort'], title: '算法学习指南', snippet: '《算法导论》(CLRS)权威;LeetCode 按专题刷(数组→树→图→DP);可视化看 visualgo.net。先掌握复杂度分析。' },
    { keywords: ['system design', '系统设计'], title: '系统设计学习指南', snippet: '《Designing Data-Intensive Applications》核心;ByteByteGo 系列;练手:设计 URL 短链、推特时间线、限流系统。' },
    { keywords: ['rust'], title: 'Rust 学习指南', snippet: '《The Rust Programming Language》(rust-lang.org/book)官方书;理解所有权/借用/生命周期;rustlings 练习;用 cargo 做 CLI 项目。' },
    { keywords: ['git', '版本控制'], title: 'Git 学习指南', snippet: 'Pro Git 书(git-scm.com/book/zh);掌握 commit/branch/merge/rebase;理解暂存区与工作区;GitHub Flow 协作。' },
    { keywords: ['sql', '数据库', 'database'], title: '数据库学习指南', snippet: 'SQLZoo/LeetCode 数据库题练 SQL;《数据库系统概念》理论;理解索引、事务、ACID、范式;PostgreSQL 官方文档实践。' },
    { keywords: ['linux', 'shell', 'bash'], title: 'Linux/Shell 学习指南', snippet: '《鸟哥的 Linux 私房菜》;掌握文件权限、管道、重定向、常用命令(grep/sed/awk);写 shell 脚本自动化任务。' },
  ];

  for (const k of knowledge) {
    if (k.keywords.some((kw) => q.includes(kw))) tips.push({ title: k.title, snippet: k.snippet });
  }
  tips.push({ title: '通用学习建议', snippet: '先建立心智模型再写代码;费曼学习法(讲给别人听);刻意练习+及时反馈;把大主题拆成可独立验证的小里程碑。' });
  tips.push({ title: '资源检索技巧', snippet: '官方文档优先 > 经典书籍 > 系统课程 > 博客;用英文关键词搜索质量更高;GitHub stars 高+近期更新的仓库更可靠。' });
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

// ─── 导出 aipack Tool ──────────────────────────────────────────

export function createSearchTool(serpapiKey?: string): Tool {
  return {
    name: 'search_web',
    description:
      '搜索网络获取学习主题相关的权威资料(官方文档、教程、课程、论文、GitHub 仓库等)。' +
      '输入 query 搜索词,返回最相关的网页结果标题与摘要。当需要了解主题的真实信息、优质资源或实例时调用。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索词,如 "Python 入门 教程" 或 "transformer 原理 论文"' },
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
      return { content: [{ type: 'text', text: formatResults(query, results, '内置教育知识(兜底)') }], details: { source: 'fallback', count: results.length } };
    },
  };
}

/** 供 config.ts 展示当前搜索后端链 */
export function describeSearchBackend(serpapiKey?: string): string {
  return serpapiKey ? 'serpapi' : 'bing+duckduckgo+fallback';
}
