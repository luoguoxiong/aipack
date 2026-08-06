/**
 * apps/ai_travel_agent/src/server.ts
 *
 * 原生 http 服务(零运行时框架依赖):
 *   - GET  /                 → public/index.html
 *   - GET  /<static>          → public/app.js / style.css / favicon
 *   - GET  /api/config        → 当前模型/搜索后端状态(JSON)
 *   - POST /api/plan          → SSE 流式:research_start → research_done → plan_start → plan_delta* → done
 *   - POST /api/ics           → 生成并下载 .ics 文件
 *
 * 启动:pnpm --filter ai-travel-agent dev
 */
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, resolveModelChoice } from './config.js';
import {
  createRuntimeRegistry,
  planTravel,
  type PlanProgress,
  type RuntimePair,
  type RuntimeRegistry,
} from './runtime.js';
import { describeSearchBackend } from './tools/search.js';
import { generateIcs } from './itinerary.js';

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

async function main() {
  const config = loadConfig();

  // Runtime 注册表:按用户选择的模型按需构建并缓存(支持运行时切换模型)
  const registry = createRuntimeRegistry(config.serpapiKey);

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host}`);

      // ── GET /api/config ───────────────────────────────────────
      if (req.method === 'GET' && url.pathname === '/api/config') {
        return json(res, 200, {
          provider: config.provider,
          model: config.modelId,
          llmReady: config.llmReady,
          searchBackend: describeSearchBackend(config.serpapiKey),
          defaultModel: { provider: config.provider, modelId: config.modelId },
          models: config.models,
        });
      }

      // ── POST /api/plan (SSE 流式) ──────────────────────────────
      if (req.method === 'POST' && url.pathname === '/api/plan') {
        return handlePlan(req, res, { registry, fallback: { provider: config.provider, modelId: config.modelId } });
      }

      // ── POST /api/ics ──────────────────────────────────────────
      if (req.method === 'POST' && url.pathname === '/api/ics') {
        return handleIcs(req, res);
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
      '║        🛫  AI Travel Agent (agentpack)           ║',
      '╠══════════════════════════════════════════════════╣',
      `║  模型:     ${pad(`${config.provider}/${config.modelId}`, 38)}║`,
      `║  LLM 就绪: ${pad(config.llmReady ? '✅ 是' : '❌ 否(请配置 API Key)', 38)}║`,
      `║  搜索后端: ${pad(describeSearchBackend(config.serpapiKey), 38)}║`,
      `║  地址:     ${pad(`http://localhost:${config.port}`, 38)}║`,
      '╚══════════════════════════════════════════════════╝',
      '',
    ].join('\n');
    console.log(banner);
  });

  // 优雅退出
  const shutdown = async (sig: string) => {
    console.log(`\n[${sig}] 正在关闭...`);
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

// ─── SSE: /api/plan ────────────────────────────────────────────────

async function handlePlan(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: { registry: RuntimeRegistry; fallback: { provider: string; modelId: string } },
) {
  const body =
    (await readJson(req).catch(() => null)) as
      | { destination?: string; days?: number; model?: { provider?: string; modelId?: string }; apiKey?: string }
      | null;
  if (!body || typeof body.destination !== 'string' || !body.destination.trim()) {
    return json(res, 400, { error: '缺少 destination 参数' });
  }
  const destination = body.destination.trim();
  const days = Number(body.days) || 7;

  // 校验并解析模型选择(缺省回退默认模型);未配置 Key 或未知模型 → 400
  const { choice, error: modelError } = resolveModelChoice(body.model, ctx.fallback, body.apiKey);
  if (modelError) {
    return json(res, 400, { error: modelError });
  }
  let runtimes: RuntimePair;
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

  const onProgress = (p: PlanProgress) => {
    if (p.type === 'plan_delta') send('delta', { delta: p.delta });
    else if (p.type === 'research_start') send('stage', { stage: 'research_start' });
    else if (p.type === 'research_done') send('stage', { stage: 'research_done', research: p.research });
    else if (p.type === 'plan_start') send('stage', { stage: 'plan_start' });
    else if (p.type === 'done') send('done', { itinerary: p.itinerary });
    else if (p.type === 'error') send('error', { message: p.message });
  };

  try {
    await planTravel({ destination, days, modelKey: choice.modelKey }, runtimes, onProgress, ac.signal);
  } catch (err) {
    const msg = (err as Error).message === 'aborted' ? '客户端已断开' : (err as Error).message;
    if (msg !== '客户端已断开') {
      send('error', { message: msg });
      console.error('[/api/plan] 失败:', err);
    }
  } finally {
    res.end();
  }
}

// ─── POST /api/ics ─────────────────────────────────────────────────

async function handleIcs(req: http.IncomingMessage, res: http.ServerResponse) {
  const body = (await readJson(req).catch(() => null)) as { itinerary?: string; startDate?: string } | null;
  if (!body || typeof body.itinerary !== 'string') {
    return json(res, 400, { error: '缺少 itinerary 参数' });
  }
  const startDate = body.startDate ? new Date(body.startDate) : new Date();
  if (isNaN(startDate.getTime())) {
    return json(res, 400, { error: 'startDate 格式无效' });
  }
  const ics = generateIcs(body.itinerary as string, startDate);
  res.writeHead(200, {
    'Content-Type': 'text/calendar; charset=utf-8',
    'Content-Disposition': 'attachment; filename="travel_itinerary.ics"',
  });
  res.end(ics);
}

// ─── 静态资源 ──────────────────────────────────────────────────────

async function serveStatic(pathname: string, res: http.ServerResponse) {
  // 安全:禁止路径穿越
  const safe = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  let filePath = path.join(PUBLIC_DIR, safe);
  if (filePath === PUBLIC_DIR || filePath === PUBLIC_DIR + '/') filePath = path.join(PUBLIC_DIR, 'index.html');
  // 目录 → index.html
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
      if (raw.length > 1_000_000) reject(new Error('body too large')), req.destroy();
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
