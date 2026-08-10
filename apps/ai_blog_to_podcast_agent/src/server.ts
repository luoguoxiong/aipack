/**
 * apps/ai_blog_to_podcast_agent/src/server.ts
 *
 * 原生 http 服务(零运行时框架依赖):
 *   - GET  /                 → public/index.html
 *   - GET  /<static>          → public/app.js / style.css / favicon
 *   - GET  /api/config        → 当前模型/抓取后端/语音列表状态(JSON)
 *   - POST /api/podcast       → SSE 流式:scrape_start → scrape_done → summary_start → summary_delta* → done
 *   - POST /api/tts           → 合成并下载 .mp3 二进制(Edge TTS 免费,无需 Key)
 *
 * 启动:pnpm --filter ai-blog-to-podcast-agent dev
 */
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, resolveModelChoice } from './config.js';
import {
  createRuntimeRegistry,
  generatePodcast,
  type PodcastProgress,
  type RuntimeRegistry,
} from './runtime.js';
import { synthesizeSpeech, VOICES } from './tts.js';

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
  const registry = createRuntimeRegistry(config.firecrawlKey);

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host}`);

      // ── GET /api/config ───────────────────────────────────────
      if (req.method === 'GET' && url.pathname === '/api/config') {
        return json(res, 200, {
          provider: config.provider,
          model: config.modelId,
          llmReady: config.llmReady,
          scrapeBackend: config.scrapeBackend,
          defaultModel: { provider: config.provider, modelId: config.modelId },
          models: config.models,
          voices: VOICES,
          ttsBackend: 'edge-tts(免费·无需Key)',
        });
      }

      // ── POST /api/podcast (SSE 流式) ──────────────────────────
      if (req.method === 'POST' && url.pathname === '/api/podcast') {
        return handlePodcast(req, res, {
          registry,
          fallback: { provider: config.provider, modelId: config.modelId },
        });
      }

      // ── POST /api/tts (二进制音频) ────────────────────────────
      if (req.method === 'POST' && url.pathname === '/api/tts') {
        return handleTts(req, res);
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
      '║      🎙️  AI Blog to Podcast (aipack)         ║',
      '╠══════════════════════════════════════════════════╣',
      `║  模型:     ${pad(`${config.provider}/${config.modelId}`, 38)}║`,
      `║  LLM 就绪: ${pad(config.llmReady ? '✅ 是' : '❌ 否(请配置 API Key)', 38)}║`,
      `║  抓取后端: ${pad(config.scrapeBackend, 38)}║`,
      `║  TTS:      ${pad('Edge TTS(免费·无需Key)', 38)}║`,
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

// ─── SSE: /api/podcast ────────────────────────────────────────────

async function handlePodcast(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: { registry: RuntimeRegistry; fallback: { provider: string; modelId: string } },
) {
  const body =
    (await readJson(req).catch(() => null)) as
      | { url?: string; model?: { provider?: string; modelId?: string }; apiKey?: string }
      | null;
  if (!body || typeof body.url !== 'string' || !body.url.trim()) {
    return json(res, 400, { error: '缺少 url 参数' });
  }
  const url = body.url.trim();
  // 简单 URL 校验
  try {
    new URL(url);
  } catch {
    return json(res, 400, { error: 'url 格式无效' });
  }

  // 校验并解析模型选择(缺省回退默认模型);未配置 Key 或未知模型 → 400
  const { choice, error: modelError } = resolveModelChoice(body.model, ctx.fallback, body.apiKey);
  if (modelError) {
    return json(res, 400, { error: modelError });
  }
  let runtime;
  try {
    runtime = ctx.registry.get(choice.provider, choice.modelId, choice.apiKey);
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

  const onProgress = (p: PodcastProgress) => {
    if (p.type === 'summary_delta') send('delta', { delta: p.delta });
    else if (p.type === 'scrape_start') send('stage', { stage: 'scrape_start' });
    else if (p.type === 'scrape_done') send('stage', { stage: 'scrape_done' });
    else if (p.type === 'summary_start') send('stage', { stage: 'summary_start' });
    else if (p.type === 'done') send('done', { summary: p.summary });
    else if (p.type === 'error') send('error', { message: p.message });
  };

  try {
    await generatePodcast({ url, modelKey: choice.modelKey }, runtime, onProgress, ac.signal);
  } catch (err) {
    const msg = (err as Error).message === 'aborted' ? '客户端已断开' : (err as Error).message;
    if (msg !== '客户端已断开') {
      send('error', { message: msg });
      console.error('[/api/podcast] 失败:', err);
    }
  } finally {
    res.end();
  }
}

// ─── POST /api/tts(二进制音频,Edge TTS 免费)─────────────────────────

async function handleTts(req: http.IncomingMessage, res: http.ServerResponse) {
  const body =
    (await readJson(req).catch(() => null)) as
      | { text?: string; voice?: string; rate?: string; volume?: string }
      | null;
  if (!body || typeof body.text !== 'string' || !body.text.trim()) {
    return json(res, 400, { error: '缺少 text 参数' });
  }

  try {
    const { audio, voiceUsed } = await synthesizeSpeech({
      text: body.text,
      voice: body.voice,
      rate: body.rate,
      volume: body.volume,
    });
    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Content-Disposition': 'attachment; filename="podcast.mp3"',
      'Content-Length': String(audio.length),
      'X-TTS-Voice': voiceUsed,
    });
    res.end(audio);
  } catch (err) {
    console.error('[/api/tts] 失败:', (err as Error).message);
    return json(res, 500, { error: 'TTS 生成失败', message: (err as Error).message });
  }
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
      if (raw.length > 2_000_000) reject(new Error('body too large')), req.destroy(); // 摘要+TTS 文本可能较大,放宽到 2MB
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
