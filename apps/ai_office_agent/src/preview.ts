/**
 * apps/ai_office_agent/src/preview.ts
 *
 * Office 文档「所见即所得」预览:基于 OfficeCLI 的 `watch` 子命令。
 *
 * `officecli watch <file> --port <port>` 会启动一个 HTTP 预览服务器,
 * 渲染效果与 Office/LibreOffice 一致(xlsx 表格、docx 排版、pptx 幻灯片),
 * 页面无 X-Frame-Options,可被 iframe 嵌入。文档被 officecli 修改后预览页会自动刷新。
 *
 * 本模块负责 watch 进程的启动/缓存/清理:
 *   - 按文件路径缓存,重复预览复用端口
 *   - 动态分配空闲端口,支持多文件同时预览
 *   - LRU 上限(默认 3),超出时关闭最久未用的进程
 *   - stopAllWatch() 供工作区切换 / 服务关闭时统一清理
 */
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';

const WATCH_MAX = 3; // 同时保留的最大 watch 进程数(超出按 LRU 关闭)
const WATCH_START_TIMEOUT_MS = 15_000;

interface WatchEntry {
  port: number;
  proc: ChildProcess;
  lastUsed: number;
}

const watchCache = new Map<string, WatchEntry>();

/** 找本机一个空闲端口 */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

function stopWatch(abs: string) {
  const entry = watchCache.get(abs);
  if (!entry) return;
  watchCache.delete(abs);
  // 通知 officecli 停止 watch(防止驻留进程残留)
  try {
    spawn('officecli', ['unwatch', abs], { stdio: 'ignore' }).unref();
  } catch {
    // ignore
  }
  try {
    entry.proc.kill('SIGINT');
  } catch {
    // ignore
  }
}

/**
 * 确保目标文件有运行的 watch 预览进程,返回其预览端口。
 * 已缓存则直接复用;否则启动新进程并等待就绪。
 */
export async function ensureWatch(abs: string): Promise<number> {
  const cached = watchCache.get(abs);
  if (cached) {
    cached.lastUsed = Date.now();
    return cached.port;
  }

  // LRU:超过上限时关闭最久未用的
  if (watchCache.size >= WATCH_MAX) {
    let oldest: [string, WatchEntry] | null = null;
    for (const [k, v] of watchCache) {
      if (!oldest || v.lastUsed < oldest[1].lastUsed) oldest = [k, v];
    }
    if (oldest) stopWatch(oldest[0]);
  }

  const port = await findFreePort();
  const proc = spawn('officecli', ['watch', abs, '--port', String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const entry: WatchEntry = { port, proc, lastUsed: Date.now() };
  watchCache.set(abs, entry);

  proc.stderr.on('data', (d) => {
    const s = String(d).trim();
    if (s) console.error(`[watch:${path.basename(abs)}] ${s}`);
  });
  proc.on('exit', () => {
    if (watchCache.get(abs) === entry) watchCache.delete(abs);
  });

  // 等待 stdout 输出 "Watch: http://localhost:<port>" 确认就绪
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      stopWatch(abs);
      reject(new Error('officecli watch 启动超时'));
    }, WATCH_START_TIMEOUT_MS);
    const onData = (d: Buffer) => {
      const s = String(d);
      if (s.includes(`http://localhost:${port}`) || s.includes(`http://127.0.0.1:${port}`)) {
        clearTimeout(timer);
        proc.stdout?.off('data', onData);
        resolve();
      }
    };
    proc.stdout?.on('data', onData);
    proc.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`officecli watch 意外退出,code=${code}`));
    });
  });

  return port;
}

/** 停止所有 watch 进程(工作区切换 / 服务关闭时调用) */
export function stopAllWatch() {
  for (const abs of [...watchCache.keys()]) stopWatch(abs);
}
