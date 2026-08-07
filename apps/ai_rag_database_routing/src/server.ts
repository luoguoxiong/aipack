/**
 * apps/ai_rag_database_routing/src/server.ts
 *
 * 原生 http 服务(零运行时框架依赖):
 *   - GET  /                 → public/index.html
 *   - GET  /<static>          → public/app.js / style.css / favicon
 *   - GET  /api/config        → 模型状态 + 各数据库统计(JSON)
 *   - POST /api/upload        → 上传文本到指定数据库 { collection, files, texts }
 *   - POST /api/clear         → 清空指定数据库 { collection }
 *   - POST /api/query         → SSE 流式:routing → answer_start → delta* → done
 *
 * 启动:pnpm --filter ai-rag-database-routing dev
 */
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, resolveModelChoice } from './config.js';
import { createRuntimeRegistry, type RuntimeRegistry } from './runtime.js';
import { VectorStore, isCollectionId, COLLECTIONS } from './vectordb.js';
import { answerQuestion, type QueryEvent } from './routing.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '../public');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** 上传体上限(含文件文本):20MB */
const MAX_BODY = 20 * 1024 * 1024;

async function main() {
  const config = loadConfig();

  // 向量存储(自动从磁盘加载)+ Runtime 注册表(按用户选择模型按需构建)
  const store = new VectorStore({ dir: config.vectorDbDir });
  const registry = createRuntimeRegistry();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host}`);

      // ── GET /api/config ───────────────────────────────────────
      if (req.method === 'GET' && url.pathname === '/api/config') {
        return json(res, 200, {
          provider: config.provider,
          model: config.modelId,
          llmReady: config.llmReady,
          routingThreshold: config.routingThreshold,
          defaultModel: { provider: config.provider, modelId: config.modelId },
          models: config.models,
          databases: store.stats(),
        });
      }

      // ── POST /api/upload ───────────────────────────────────────
      if (req.method === 'POST' && url.pathname === '/api/upload') {
        return handleUpload(req, res, store);
      }

      // ── POST /api/clear ────────────────────────────────────────
      if (req.method === 'POST' && url.pathname === '/api/clear') {
        return handleClear(req, res, store);
      }

      // ── POST /api/query (SSE 流式) ─────────────────────────────
      if (req.method === 'POST' && url.pathname === '/api/query') {
        return handleQuery(req, res, {
          registry,
          store,
          serpapiKey: config.serpapiKey,
          routingThreshold: config.routingThreshold,
          fallback: { provider: config.provider, modelId: config.modelId },
        });
      }

      // ── 静态资源 ───────────────────────────────────────────────
      if (req.method === 'GET') {
        return serveStatic(url.pathname, res);
      }

      return json(res, 405, { error: 'Method Not Allowed' });
    } catch (err) {
      console.error('[server] 未捕获错误:', err);
      return json(res, 500, { error: 'Internal Server Error', message: (err as Error).message });
    }
  });

  server.listen(config.port, () => {
    const banner = [
      '',
      '╔══════════════════════════════════════════════════╗',
      '║    📚  RAG Agent Database Routing (agentpack)    ║',
      '╠══════════════════════════════════════════════════╣',
      `║  模型:     ${pad(`${config.provider}/${config.modelId}`, 38)}║`,
      `║  LLM 就绪: ${pad(config.llmReady ? '✅ 是' : '❌ 否(请配置 API Key)', 38)}║`,
      `║  路由阈值: ${pad(String(config.routingThreshold), 38)}║`,
      `║  地址:     ${pad(`http://localhost:${config.port}`, 38)}║`,
      '╚══════════════════════════════════════════════════╝',
      '',
    ].join('\n');
    console.log(banner);
  });

  // 优雅退出
  const shutdown = async (sig: string) => {
    console.log(`\n[${sig}] 正在关闭...`);
    store.save();
    server.close();
    await registry.closeAll();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

function pad(s: string, n: number): string {
  // 中文字符按 2 宽度计算
  let width = 0;
  for (const ch of s) width += ch.charCodeAt(0) > 0x7f ? 2 : 1;
  const need = Math.max(0, n - width);
  return s + ' '.repeat(need);
}

// ─── POST /api/upload ─────────────────────────────────────────────

interface UploadBody {
  collection?: unknown;
  files?: Array<{ name?: unknown; content?: unknown }>;
  texts?: unknown;
}

async function handleUpload(req: http.IncomingMessage, res: http.ServerResponse, store: VectorStore) {
  const body = (await readJson(req).catch(() => null)) as UploadBody | null;
  if (!body || typeof body.collection !== 'string' || !isCollectionId(body.collection)) {
    return json(res, 400, { error: '缺少或非法的 collection 参数' });
  }

  const sources: Array<{ name: string; content: string }> = [];
  if (Array.isArray(body.files)) {
    for (const f of body.files) {
      if (f && typeof f.name === 'string' && typeof f.content === 'string' && f.content.trim()) {
        sources.push({ name: f.name.slice(0, 120), content: f.content });
      }
    }
  }
  if (typeof body.texts === 'string' && body.texts.trim()) {
    sources.push({ name: '粘贴文本', content: body.texts });
  }

  if (sources.length === 0) {
    return json(res, 400, { error: '未提供任何有效文本内容' });
  }

  let added = 0;
  let skipped = 0;
  for (const src of sources) {
    const r = store.addTexts(body.collection, [src.content], src.name);
    added += r.added;
    skipped += r.skipped;
  }
  store.save();

  const stats = store.stats();
  const target = stats.find((s) => s.collection === body.collection)!;
  return json(res, 200, {
    collection: body.collection,
    added,
    skipped,
    total: target.chunkCount,
  });
}

// ─── POST /api/clear ──────────────────────────────────────────────

async function handleClear(req: http.IncomingMessage, res: http.ServerResponse, store: VectorStore) {
  const body = (await readJson(req).catch(() => null)) as { collection?: unknown } | null;
  if (!body || typeof body.collection !== 'string' || !isCollectionId(body.collection)) {
    return json(res, 400, { error: '缺少或非法的 collection 参数' });
  }
  const removed = store.clear(body.collection);
  store.save();
  return json(res, 200, { collection: body.collection, removed, total: 0 });
}

// ─── POST /api/query (SSE) ────────────────────────────────────────

async function handleQuery(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: {
    registry: RuntimeRegistry;
    store: VectorStore;
    serpapiKey?: string;
    routingThreshold: number;
    fallback: { provider: string; modelId: string };
  },
) {
  const body =
    (await readJson(req).catch(() => null)) as
      | { question?: string; model?: { provider?: string; modelId?: string }; apiKey?: string }
      | null;
  if (!body || typeof body.question !== 'string' || !body.question.trim()) {
    return json(res, 400, { error: '缺少 question 参数' });
  }
  const question = body.question.trim();

  // 校验并解析模型选择(缺省回退默认模型);未配置 Key 或未知模型 → 400
  const { choice, error: modelError } = resolveModelChoice(body.model, ctx.fallback, body.apiKey);
  if (modelError) {
    return json(res, 400, { error: modelError });
  }
  let runtimes;
  try {
    runtimes = ctx.registry.get(choice.provider, choice.modelId, choice.apiKey);
  } catch (e) {
    return json(res, 400, { error: (e as Error).message });
  }

  // SSE 头(禁用代理缓冲,保证流式)
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // 客户端断开 → 中止
  const ac = new AbortController();
  req.on('close', () => ac.abort());

  const onEvent = (e: QueryEvent) => {
    switch (e.type) {
      case 'routing_start':
        send('routing', { stage: 'start' });
        break;
      case 'routing_done':
        send('routing', {
          stage: 'done',
          method: e.method,
          collection: e.collection ?? null,
          confidence: e.confidence ?? null,
          note: e.note ?? null,
        });
        break;
      case 'answer_start':
        send('answer_start', { source: e.source, collection: e.collection ?? null });
        break;
      case 'answer_delta':
        send('delta', { delta: e.delta });
        break;
      case 'done':
        send('done', { answer: e.answer });
        break;
      case 'error':
        send('error', { message: e.message });
        break;
    }
  };

  try {
    await answerQuestion(
      { question },
      {
        store: ctx.store,
        runtimes,
        serpapiKey: ctx.serpapiKey,
        routingThreshold: ctx.routingThreshold,
      },
      onEvent,
      ac.signal,
    );
  } catch (err) {
    const msg = (err as Error).message === 'aborted' ? '客户端已断开' : (err as Error).message;
    if (msg !== '客户端已断开') {
      send('error', { message: msg });
      console.error('[/api/query] 失败:', err);
    }
  } finally {
    res.end();
  }
}

// ─── 静态资源 ──────────────────────────────────────────────────────

async function serveStatic(pathname: string, res: http.ServerResponse) {
  // 安全:禁止路径穿越
  const safe = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  let filePath = path.join(PUBLIC_DIR, safe);
  if (filePath === PUBLIC_DIR || filePath === PUBLIC_DIR + '/') filePath = path.join(PUBLIC_DIR, 'index.html');
  try {
    const stat = await fs.stat(filePath);
    if (stat.isDirectory()) filePath = path.join(filePath, 'index.html');
  } catch {
    // 文件不存在 → 回退 index.html(SPA)
    filePath = path.join(PUBLIC_DIR, 'index.html');
  }

  try {
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
}

// ─── 工具:JSON 读取/响应 ───────────────────────────────────────────

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > MAX_BODY) reject(new Error('body too large')), req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

main().catch((err) => {
  console.error('启动失败:', err);
  process.exit(1);
});
