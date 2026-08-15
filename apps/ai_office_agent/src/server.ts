/**
 * apps/ai_office_agent/src/server.ts
 *
 * 原生 http 服务(零运行时框架依赖):
 *   - GET  /                          → public/index.html
 *   - GET  /<static>                   → public/app.js / style.css
 *   - GET  /api/config                 → 模型/工作区状态(JSON)
 *   - POST /api/chat                   → SSE 流式:text/tool_start/tool_end/done
 *   - GET  /api/workspace              → 当前工作区信息(JSON)
 *   - POST /api/workspace              → 切换工作区目录(body: { path },持久化)
 *   - PUT  /api/import-file?path=      → 导入工作区文件(body=原始字节)
 *   - DELETE /api/import-folder        → 清空导入目录
 *   - POST /api/import-folder/commit   → 导入完成,切换工作区为导入目录
 *   - GET  /api/files                  → 工作区文件列表(JSON,供前端文件面板)
 *   - GET  /api/files/<relpath>        → 下载工作区文件(路径校验防越界)
 *
 * 启动:pnpm --filter ai-office-agent dev
 */
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, buildModel, resolveModelChoice } from './config.js';
import { createOfficeRuntime, runOfficeAgent, type OfficeEvent } from './runtime.js';
import { createWorkspace } from './tools/workspace.js';
import { listWorkspaceFiles } from './tools/file-tools.js';
import { officecliAvailable } from './tools/officecli.js';
import { ensureWatch, stopAllWatch } from './preview.js';
import type { Runtime } from '@aipack/agent';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '../public');
/** 工作区选择持久化文件(服务重启后沿用上次选择) */
const STATE_FILE = path.resolve(__dirname, '../.aipack/workspace-state.json');
/** 「选择本地文件夹」导入的工作区根目录(系统文件夹选择器只能取到内容,故采用导入方式) */
const IMPORT_ROOT = path.resolve(__dirname, '../import-workspace');
/** 导入单文件大小上限 */
const IMPORT_MAX_FILE = 50 * 1024 * 1024;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  // Office 文档
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.pdf': 'application/pdf',
  '.csv': 'text/csv; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.bak': 'application/octet-stream',
};

/** 开发模式:开启前端自动刷新(public/ 改动或服务重启时浏览器自动 reload),生产可设 NODE_ENV=production 关闭 */
const IS_DEV = process.env.NODE_ENV !== 'production';
/** 每次服务启动都会变化,配合 tsx watch 让后端改动也能触发浏览器自动刷新 */
const BOOT_ID = `${process.pid}:${Date.now()}`;

async function main() {
  const config = loadConfig();

  // 文件工作区(与 Office 工具共用同一目录):优先加载上次持久化的选择
  let ws = await createWorkspace(config.workspace);
  try {
    const saved = JSON.parse(await fs.readFile(STATE_FILE, 'utf-8')) as { root?: unknown };
    if (typeof saved.root === 'string' && saved.root.trim()) {
      ws = await createWorkspace(saved.root);
    }
  } catch {
    // 无持久化记录 → 使用默认工作区
  }
  const saveWorkspaceState = async () => {
    await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
    await fs.writeFile(STATE_FILE, JSON.stringify({ root: ws.root }, null, 2));
  };
  await saveWorkspaceState();

  // Runtime 注册表:按「工作区 + 模型」按需构建并缓存(切换模型/工作区时重建)
  const cache = new Map<string, Runtime>();
  const getRuntime = async (provider: string, modelId: string, apiKey?: string): Promise<Runtime> => {
    const cacheKey = `${ws.root}|${provider}/${modelId}:${apiKey ? `u:${apiKey.slice(0, 4)}` : 'env'}`;
    let rt = cache.get(cacheKey);
    if (!rt) {
      const { model, streamFn } = buildModel(provider, modelId, apiKey);
      rt = await createOfficeRuntime(model, streamFn, ws.root);
      cache.set(cacheKey, rt);
    }
    return rt;
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host}`);

      // ── GET /api/config ───────────────────────────────────────
      if (req.method === 'GET' && url.pathname === '/api/config') {
        return json(res, 200, {
          provider: config.provider,
          model: config.modelId,
          llmReady: config.llmReady,
          defaultModel: { provider: config.provider, modelId: config.modelId },
          models: config.models,
          workspace: path.basename(ws.root),
          tools: ['office_read', 'office_help', 'office_exec', 'file_list', 'file_delete'],
        });
      }

      // ── GET /api/workspace (当前工作区) ────────────────────────
      if (req.method === 'GET' && url.pathname === '/api/workspace') {
        return json(res, 200, {
          root: ws.root,
          name: path.basename(ws.root),
          defaultRoot: config.workspace,
        });
      }

      // ── POST /api/workspace (切换工作区) ───────────────────────
      if (req.method === 'POST' && url.pathname === '/api/workspace') {
        const body = (await readJson(req).catch(() => null)) as { path?: unknown } | null;
        const p = typeof body?.path === 'string' ? body.path.trim() : '';
        if (!p) return json(res, 400, { error: '缺少 path 参数' });
        if (p.length > 1024) return json(res, 400, { error: '路径过长(限 1024 字符)' });
        ws = await createWorkspace(path.resolve(p));
        cache.clear(); // 工具绑定工作区,切换后必须重建 Runtime
        stopAllWatch(); // 旧工作区的 watch 预览进程一并释放
        await saveWorkspaceState();
        const files = await listWorkspaceFiles(ws);
        return json(res, 200, { root: ws.root, name: path.basename(ws.root), files });
      }

      // ── PUT /api/import-file (导入工作区文件:body=原始字节) ───
      if (req.method === 'PUT' && url.pathname === '/api/import-file') {
        const rel = (url.searchParams.get('path') || '').replace(/^[/\\]+/, '');
        if (!rel || rel.includes('\0') || rel.split(/[/\\]/).includes('..')) {
          return json(res, 400, { error: '路径无效' });
        }
        if (rel.length > 1024) return json(res, 400, { error: '路径过长' });
        const abs = path.join(IMPORT_ROOT, rel);
        await fs.mkdir(path.dirname(abs), { recursive: true });
        const chunks: Buffer[] = [];
        let total = 0;
        for await (const chunk of req) {
          total += (chunk as Buffer).length;
          if (total > IMPORT_MAX_FILE) {
            return json(res, 413, { error: '单文件超过 50MB' });
          }
          chunks.push(chunk as Buffer);
        }
        await fs.writeFile(abs, Buffer.concat(chunks));
        return json(res, 200, { ok: true, path: rel });
      }

      // ── DELETE /api/import-folder (清空导入目录) ───────────────
      if (req.method === 'DELETE' && url.pathname === '/api/import-folder') {
        await fs.rm(IMPORT_ROOT, { recursive: true, force: true });
        return json(res, 200, { ok: true });
      }

      // ── POST /api/import-folder/commit (导入完成,切换工作区) ──
      if (req.method === 'POST' && url.pathname === '/api/import-folder/commit') {
        let stat;
        try {
          stat = await fs.stat(IMPORT_ROOT);
        } catch {
          return json(res, 400, { error: '请先选择文件夹导入文件' });
        }
        if (!stat.isDirectory()) return json(res, 400, { error: '导入目录异常' });
        ws = await createWorkspace(IMPORT_ROOT);
        cache.clear(); // 工具绑定工作区,切换后必须重建 Runtime
        stopAllWatch(); // 旧工作区的 watch 预览进程一并释放
        await saveWorkspaceState();
        const files = await listWorkspaceFiles(ws);
        return json(res, 200, { root: ws.root, name: path.basename(ws.root), files });
      }

      // ── POST /api/chat (SSE 流式) ─────────────────────────────
      if (req.method === 'POST' && url.pathname === '/api/chat') {
        return handleChat(req, res, {
          getRuntime,
          fallback: { provider: config.provider, modelId: config.modelId },
        });
      }

      // ── GET /api/files (工作区文件列表) ───────────────────────
      if (req.method === 'GET' && url.pathname === '/api/files') {
        const files = await listWorkspaceFiles(ws);
        return json(res, 200, { files });
      }

      // ── GET /api/files/<relpath> (下载) ───────────────────────
      if (req.method === 'GET' && url.pathname.startsWith('/api/files/')) {
        return handleFileDownload(url.pathname, ws, res);
      }

      // ── GET /api/preview/<relpath> (在线预览) ──────────────────
      if (req.method === 'GET' && url.pathname.startsWith('/api/preview/')) {
        return handlePreview(url.pathname, ws, res);
      }

      // ── GET /api/live-reload (开发模式前端自动刷新指纹) ─────
      if (req.method === 'GET' && url.pathname === '/api/live-reload') {
        if (!IS_DEV) return json(res, 404, { error: 'Not Found' });
        return json(res, 200, { v: `${BOOT_ID}:${await publicFingerprint()}` });
      }

      // ── 静态资源 ──────────────────────────────────────────────
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
      '║      📊 AI Office Agent (aipack)             ║',
      '╠══════════════════════════════════════════════════╣',
      `║  模型:     ${pad(`${config.provider}/${config.modelId}`, 38)}║`,
      `║  LLM 就绪: ${pad(config.llmReady ? '✅ 是' : '❌ 否(请配置 API Key)', 38)}║`,
      `║  工作区:   ${pad(path.basename(ws.root), 38)}║`,
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
    stopAllWatch(); // 释放所有 watch 预览进程
    await Promise.allSettled([...cache.values()].map((rt) => rt.close()));
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

function pad(s: string, n: number): string {
  let width = 0;
  for (const ch of s) width += ch.charCodeAt(0) > 0x7f ? 2 : 1;
  return s + ' '.repeat(Math.max(0, n - width));
}

// ─── SSE: /api/chat ───────────────────────────────────────────────

async function handleChat(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: {
    getRuntime: (provider: string, modelId: string, apiKey?: string) => Promise<Runtime>;
    fallback: { provider: string; modelId: string };
  },
) {
  const body =
    (await readJson(req).catch(() => null)) as
      | {
          message?: string;
          sessionKey?: string;
          model?: { provider?: string; modelId?: string };
          apiKey?: string;
          /** 用户选中的目标文件(相对工作区路径) */
          filePath?: string;
        }
      | null;
  if (!body || typeof body.message !== 'string' || !body.message.trim()) {
    return json(res, 400, { error: '缺少 message 参数' });
  }
  if (body.message.trim().length > 20000) {
    return json(res, 400, { error: '消息过长(限 20000 字符)' });
  }
  // 选中文件需合法相对路径(越界时 resolveInWorkspace 会抛错,这里先做基本校验)
  const filePath = typeof body.filePath === 'string' && body.filePath.trim() ? body.filePath.trim() : undefined;

  const { choice, error: modelError } = resolveModelChoice(body.model, ctx.fallback, body.apiKey);
  if (modelError) return json(res, 400, { error: modelError });

  let runtime: Runtime;
  try {
    runtime = await ctx.getRuntime(choice.provider, choice.modelId, choice.apiKey);
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

  const ac = new AbortController();
  req.on('close', () => ac.abort());

  const onEvent = (e: OfficeEvent) => {
    switch (e.type) {
      case 'text':
        send('delta', { delta: e.content });
        break;
      case 'thinking':
        send('thinking', { delta: e.content });
        break;
      case 'tool_start':
        send('tool', { state: 'start', toolName: e.toolName });
        break;
      case 'tool_end':
        send('tool', { state: 'end', toolName: e.toolName, isError: e.isError });
        break;
      case 'done':
        send('done', {});
        break;
    }
  };

  try {
    await runOfficeAgent(
      { message: body.message.trim(), sessionKey: body.sessionKey, filePath },
      runtime,
      onEvent,
      ac.signal,
    );
  } catch (err) {
    const msg = (err as Error).message === 'aborted' ? '客户端已断开' : (err as Error).message;
    if (msg !== '客户端已断开') {
      send('error', { message: msg });
      console.error('[/api/chat] 失败:', err);
    }
  } finally {
    res.end();
  }
}

// ─── 在线预览工作区文件 ────────────────────────────────────────────

/** 可在线预览的文件类型分类(按扩展名) */
const PREVIEW_TEXT_EXTS = new Set(['.txt', '.md', '.csv', '.json', '.log', '.html']);
const PREVIEW_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico']);
const PREVIEW_OFFICE_EXTS = new Set(['.xlsx', '.docx', '.pptx']);
const PREVIEW_MAX_CHARS = 300_000; // 文本类预览长度上限

/**
 * GET /api/preview/<relpath> → JSON:
 *   - Office(xlsx/docx/pptx):officecli view 转文本 → { kind:'office', content }
 *   - 文本类:直接读 → { kind:'text', content }
 *   - 图片:base64 dataUrl → { kind:'image', dataUrl }
 *   - PDF:浏览器原生渲染 → { kind:'pdf', url }(指向下载端点)
 *   - 其余二进制 → { kind:'unsupported' }
 * 路径校验与下载端点同一套(拒绝绝对路径与 .. 逃逸)。
 */
async function handlePreview(pathname: string, ws: { root: string }, res: http.ServerResponse) {
  let relPath: string;
  try {
    relPath = decodeURIComponent(pathname.slice('/api/preview/'.length));
    if (!relPath || relPath.includes('\0')) throw new Error('bad path');
  } catch {
    return json(res, 400, { error: '路径参数无效' });
  }
  const root = path.resolve(ws.root);
  const abs = path.resolve(root, path.normalize(relPath).replace(/^[/\\]+/, ''));
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel) || rel.startsWith('.trash')) {
    return json(res, 403, { error: '禁止访问工作区外文件' });
  }
  try {
    if (!(await fs.stat(abs)).isFile()) throw new Error('not a file');
  } catch {
    return json(res, 404, { error: `文件不存在: ${relPath}` });
  }
  const name = path.basename(abs);
  const ext = path.extname(abs).toLowerCase();

  if (PREVIEW_OFFICE_EXTS.has(ext)) {
    if (!(await officecliAvailable())) {
      return json(res, 200, {
        kind: 'error',
        name,
        ext,
        message: '预览 Office 文档需要安装 officecli:npm i -g @officecli/officecli 或 brew install officecli',
      });
    }
    try {
      // 所见即所得预览:officecli watch 渲染(与 Office 排版一致),前端 iframe 嵌入
      const port = await ensureWatch(abs);
      return json(res, 200, { kind: 'office-watch', name, ext, url: `http://localhost:${port}/` });
    } catch (e) {
      return json(res, 200, { kind: 'error', name, ext, message: `预览失败: ${(e as Error).message}` });
    }
  }

  if (PREVIEW_TEXT_EXTS.has(ext)) {
    let content = await fs.readFile(abs, 'utf-8');
    if (content.length > PREVIEW_MAX_CHARS) {
      content = content.slice(0, PREVIEW_MAX_CHARS) + '\n\n[…内容过长,仅显示前 300KB…]';
    }
    return json(res, 200, { kind: 'text', name, ext, content });
  }

  if (PREVIEW_IMAGE_EXTS.has(ext)) {
    const data = await fs.readFile(abs);
    return json(res, 200, {
      kind: 'image',
      name,
      ext,
      dataUrl: `data:${MIME[ext] || 'application/octet-stream'};base64,${data.toString('base64')}`,
    });
  }

  if (ext === '.pdf') {
    return json(res, 200, { kind: 'pdf', name, url: `/api/files/${encodeURIComponent(relPath)}` });
  }

  return json(res, 200, {
    kind: 'unsupported',
    name,
    ext,
    message: '该类型暂不支持在线预览,请下载后查看',
  });
}

// ─── 下载工作区文件 ───────────────────────────────────────────────

async function handleFileDownload(pathname: string, ws: { root: string }, res: http.ServerResponse) {
  let relPath: string;
  try {
    relPath = decodeURIComponent(pathname.slice('/api/files/'.length));
    if (!relPath || relPath.includes('\0')) throw new Error('bad path');
  } catch {
    return json(res, 400, { error: '路径参数无效' });
  }
  // 路径校验:拒绝绝对路径与 .. 逃逸(与 Office 工具同一套规则)
  const root = path.resolve(ws.root);
  const abs = path.resolve(root, path.normalize(relPath).replace(/^[/\\]+/, ''));
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel) || rel.startsWith('.trash')) {
    return json(res, 403, { error: '禁止访问工作区外文件' });
  }
  try {
    const data = await fs.readFile(abs);
    const ext = path.extname(abs).toLowerCase();
    const filename = path.basename(abs);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': String(data.length),
      'Content-Disposition': `attachment; filename="${filename.replace(/"/g, '')}"`,
    });
    res.end(data);
  } catch {
    return json(res, 404, { error: `文件不存在: ${relPath}` });
  }
}

// ─── 静态资源 ──────────────────────────────────────────────────────

/** 开发模式注入到 HTML 的自动刷新脚本:轮询 /api/live-reload,指纹变化则整页刷新 */
const LIVE_RELOAD_SCRIPT = `<script>
(function () {
  var __lr = null;
  function poll() {
    fetch('/api/live-reload', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (__lr && __lr !== d.v) { location.reload(); return; }
        __lr = d.v;
      })
      .catch(function () {})
      .then(function () { setTimeout(poll, 800); });
  }
  poll();
})();
<\/script>`;

/** public/ 目录内容指纹(文件名 + mtime + size),用于驱动前端自动刷新 */
async function publicFingerprint(): Promise<string> {
  let entries: string[];
  try {
    entries = (await fs.readdir(PUBLIC_DIR)).sort();
  } catch {
    return '';
  }
  const parts: string[] = [];
  for (const name of entries) {
    try {
      const s = await fs.stat(path.join(PUBLIC_DIR, name));
      parts.push(`${name}:${s.mtimeMs}:${s.size}`);
    } catch {
      // 忽略被并发删除的文件
    }
  }
  return parts.join('|');
}

async function serveStatic(pathname: string, res: http.ServerResponse) {
  const safe = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  let filePath = path.join(PUBLIC_DIR, safe);
  if (filePath === PUBLIC_DIR || filePath === PUBLIC_DIR + '/') filePath = path.join(PUBLIC_DIR, 'index.html');
  try {
    const stat = await fs.stat(filePath);
    if (stat.isDirectory()) filePath = path.join(filePath, 'index.html');
  } catch {
    filePath = path.join(PUBLIC_DIR, 'index.html');
  }
  try {
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const headers: Record<string, string> = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    if (IS_DEV && (ext === '.html' || ext === '.js' || ext === '.css')) {
      // 开发模式禁用缓存,保证改动后刷新即最新
      headers['Cache-Control'] = 'no-cache';
      if (ext === '.html') {
        // 注入 live-reload 脚本(仅内存中,不改磁盘文件)
        const html = data.toString('utf-8');
        const out = html.includes('</body>') ? html.replace('</body>', `${LIVE_RELOAD_SCRIPT}\n</body>`) : html + LIVE_RELOAD_SCRIPT;
        res.writeHead(200, headers);
        res.end(out);
        return;
      }
    }
    res.writeHead(200, headers);
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
      if (raw.length > 2_000_000) reject(new Error('body too large')), req.destroy();
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
