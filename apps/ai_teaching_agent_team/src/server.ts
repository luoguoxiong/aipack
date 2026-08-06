/**
 * apps/ai_teaching_agent_team/src/server.ts
 *
 * 原生 http 服务(后端零运行时框架依赖):
 *   - GET  /                 → 生产:dist/frontend/index.html(React 构建产物)
 *   - GET  /<static>          → dist/frontend 静态资源 + SPA fallback
 *   - GET  /api/config        → 当前模型/搜索后端/模型目录(JSON)
 *   - POST /api/teach         → SSE 流式:professor/advisor/librarian/ta 4 阶段全流式
 *
 * 开发态前端由 Vite(5173)提供,/api 经 Vite 代理到本服务(3001):
 *   pnpm --filter ai-teaching-agent-team dev
 * 生产态单端口:先 build(vite build + tsc),再 serve:
 *   pnpm --filter ai-teaching-agent-team serve
 */
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, resolveModelChoice } from './config.js';
import {
  createRuntimeRegistry,
  generateCourse,
  type CourseProgress,
  type RuntimeTeam,
  type RuntimeRegistry,
} from './runtime.js';
import { describeSearchBackend } from './tools/search.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 前端构建产物目录:开发态(src/)与生产态(dist/)都解析到 approot/dist/frontend
const PUBLIC_DIR = path.resolve(__dirname, '../dist/frontend');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

async function main() {
  const config = loadConfig();

  // Runtime 注册表:按用户选择的模型按需构建并缓存 4-Runtime 团队
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
          searchBackend: config.searchBackend,
          defaultModel: { provider: config.provider, modelId: config.modelId },
          models: config.models,
        });
      }

      // ── POST /api/teach (SSE 流式) ────────────────────────────
      if (req.method === 'POST' && url.pathname === '/api/teach') {
        return handleTeach(req, res, {
          registry,
          fallback: { provider: config.provider, modelId: config.modelId },
        });
      }

      // ── 静态资源(生产态;开发态由 Vite 提供)──────────────────────
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
      '║   👨‍🏫  AI Teaching Agent Team (agentpack)        ║',
      '╠══════════════════════════════════════════════════╣',
      `║  模型:     ${pad(`${config.provider}/${config.modelId}`, 38)}║`,
      `║  LLM 就绪: ${pad(config.llmReady ? '✅ 是' : '❌ 否(请配置 API Key)', 38)}║`,
      `║  搜索后端: ${pad(config.searchBackend, 38)}║`,
      `║  API:      ${pad(`http://localhost:${config.port}/api`, 38)}║`,
      `║  前端:     ${pad('dev → http://localhost:5173', 38)}║`,
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

// ─── SSE: /api/teach ────────────────────────────────────────────────

async function handleTeach(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: { registry: RuntimeRegistry; fallback: { provider: string; modelId: string } },
) {
  const body =
    (await readJson(req).catch(() => null)) as
      | { topic?: string; model?: { provider?: string; modelId?: string }; apiKey?: string }
      | null;
  if (!body || typeof body.topic !== 'string' || !body.topic.trim()) {
    return json(res, 400, { error: '缺少 topic 参数' });
  }
  const topic = body.topic.trim();

  // 校验并解析模型选择(缺省回退默认模型);未配置 Key 或未知模型 → 400
  const { choice, error: modelError } = resolveModelChoice(body.model, ctx.fallback, body.apiKey);
  if (modelError) {
    return json(res, 400, { error: modelError });
  }
  let team: RuntimeTeam;
  try {
    team = ctx.registry.get(choice.provider, choice.modelId, choice.apiKey);
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

  const onProgress = (p: CourseProgress) => {
    if (p.type === 'delta') {
      send('delta', { agent: p.agent, delta: p.delta });
    } else if (p.type === 'done') {
      send('done', { course: p.course });
    } else if (p.type === 'error') {
      send('error', { message: p.message });
    } else {
      // *_start / *_done 阶段事件
      send('stage', { stage: p.type, section: p.section });
    }
  };

  try {
    await generateCourse({ topic, modelKey: choice.modelKey }, team, onProgress, ac.signal);
  } catch (err) {
    const msg = (err as Error).message === 'aborted' ? '客户端已断开' : (err as Error).message;
    if (msg !== '客户端已断开') {
      send('error', { message: msg });
      console.error('[/api/teach] 失败:', err);
    }
  } finally {
    res.end();
  }
}

// ─── 静态资源(生产态:dist/frontend,SPA fallback)────────────────────

async function serveStatic(pathname: string, res: http.ServerResponse) {
  // 安全:禁止路径穿越
  const safe = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  let filePath = path.join(PUBLIC_DIR, safe);
  if (filePath === PUBLIC_DIR || filePath === PUBLIC_DIR + '/') filePath = path.join(PUBLIC_DIR, 'index.html');

  try {
    const stat = await fs.stat(filePath);
    if (stat.isDirectory()) filePath = path.join(filePath, 'index.html');
  } catch {
    // 文件不存在 → 回退 index.html(SPA):开发态 dist/frontend 不存在时也走此路径
    filePath = path.join(PUBLIC_DIR, 'index.html');
  }

  try {
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  } catch {
    // 生产构建未产出或开发态:返回简短提示(开发态应访问 Vite 5173)
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found\n\n(开发态请访问 http://localhost:5173;生产态请先执行 pnpm --filter ai-teaching-agent-team build)');
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
