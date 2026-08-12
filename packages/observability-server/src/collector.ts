/**
 * 收集端（createCollector）— 后台统一收集服务 + 面板 API。
 *
 *   POST /api/v1/ingest               客户端埋点上报（appId+Secret 动态鉴权）→ 落盘 + 聚合
 *   POST /api/auth/login|logout       面板登录/登出（ADMIN_USER/ADMIN_PASS）
 *   GET  /api/auth/me                 当前会话
 *   GET/POST/DELETE /api/apps*        应用管理（动态生成 appId/appSecret）
 *   GET  /metrics/*、/traces/*        查询端点（需面板 Bearer 会话，支持 appId 过滤）
 *   GET  /*                           静态文件（staticDir 配置时托管面板构建产物）
 *
 * 部署形态：本包自带 bin 入口（observability-server），或由宿主应用组装 createCollector。
 */

import http from 'node:http';
import https from 'node:https';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { EventBatch } from '@aipack/observability';
import { Aggregator } from './aggregator';
import { createApiHandler, type ApiHandler } from './server';
import { createAdminHandler, type AdminHandler } from './admin';
import { SessionManager, readBearerToken } from './auth';
import { SQLiteStore } from './store';
import { createAlertEvaluator, type AlertEvaluator } from './alerts/evaluator';
import { createNotifier } from './alerts/notify';
import { renderPrometheusMetrics } from './prometheus';
import { RateLimiter, type RateLimitOptions } from './rate-limit';

export interface RetentionOptions {
  /** 明细保留天数；<=0 或未配置则不启用清理 */
  days: number;
  /** 清理周期（ms），默认 1h */
  intervalMs?: number;
  /** 启动时先清理一次，默认 true */
  atStartup?: boolean;
  /** 清理前 VACUUM INTO 快照备份，默认 false */
  backup?: boolean;
  /** 备份目录，默认 <db 所在目录>/backup */
  backupDir?: string;
}

export interface AlertOptions {
  /** 评估周期（ms），默认 60s */
  evaluateIntervalMs?: number;
  /** 全局默认通知 webhook（规则可覆盖） */
  defaultWebhookUrl?: string;
}

export interface CollectorOptions {
  /** SQLite 文件路径（必填） */
  dbPath: string;
  /** 启动时种入的静态白名单（appId -> appSecret，OBS_APPS），已存在则跳过 */
  apps?: Record<string, string>;
  /** 面板登录凭证（observability-web 用）；缺省时不开启登录端点 */
  admin?: { username: string; password: string };
  /** 面板会话签名 secret（P2-3）：配置后签发无状态 HMAC token，重启不失效；缺省用内存会话 */
  sessionSecret?: string;
  /** 可选：托管面板静态文件目录（构建产物），配置后 GET / 直接返回面板 */
  staticDir?: string;
  /** 聚合滑动窗口（ms），默认 60min */
  windowMs?: number;
  /** 时间桶粒度（ms），默认 1min */
  bucketMs?: number;
  /** 数据保留：配置且 days>0 时启动定时清理 */
  retention?: RetentionOptions;
  /** 告警：配置后启动评估器（规则存 DB，面板 CRUD） */
  alerts?: AlertOptions;
  /** ingest 限流（per-appId 令牌桶）；配置且 rate>0 时启用 */
  rateLimit?: RateLimitOptions;
  /** 面板 Trace 详情"查看日志"跳转模板（%s 替换为 traceId），如 Loki/ELK 查询地址 */
  logStreamUrlTemplate?: string;
}

export interface Collector {
  /** 挂载到 http server：处理 ingest + 管理 API + 查询 */
  handler: ApiHandler;
  /** 告警评估器（alerts 配置时存在），测试可用 evaluateOnce 手动触发 */
  alerts?: AlertEvaluator;
  close(): Promise<void>;
}

/** TLS 证书（collector server 启用 HTTPS 用） */
export interface TlsOptions {
  key: Buffer;
  cert: Buffer;
}

/** 创建收集服务 HTTP(S) server：统一错误兜底，cli 与宿主共用 */
export function createCollectorServer(collector: Collector, tls?: TlsOptions): http.Server {
  const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
    void collector.handler(req, res).catch((err: unknown) => {
      console.error('[observability-server] 处理请求失败:', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Internal Server Error' }));
      }
    });
  };
  return tls ? https.createServer(tls, handler) : http.createServer(handler);
}

const MAX_BODY = 10 * 1024 * 1024; // ingest 单次上限 10MB

export function createCollector(opts: CollectorOptions): Collector {
  const store = new SQLiteStore(opts.dbPath);
  if (opts.apps) store.seedApps(opts.apps);

  // 全局聚合（所有应用合并）+ 按应用聚合（面板 appId 过滤）
  const globalAggregator = new Aggregator({ windowMs: opts.windowMs, bucketMs: opts.bucketMs });
  const byApp = new Map<string, Aggregator>();
  const aggregatorFor = (appId?: string): Aggregator => {
    if (!appId) return globalAggregator;
    let agg = byApp.get(appId);
    if (!agg) {
      agg = new Aggregator({ windowMs: opts.windowMs, bucketMs: opts.bucketMs });
      byApp.set(appId, agg);
    }
    return agg;
  };

  const sessions = opts.admin
    ? new SessionManager(
        { username: opts.admin.username, password: opts.admin.password },
        { secret: opts.sessionSecret },
      )
    : undefined;

  // 已知应用 id（种子白名单 + 面板动态创建），供 Prometheus 按应用拆分导出
  const appIds = (): string[] => {
    const ids = new Set<string>(Object.keys(opts.apps ?? {}));
    for (const a of store.listApps()) ids.add(a.appId);
    return Array.from(ids);
  };

  // ingest 限流（per-appId 令牌桶）
  const limiter =
    opts.rateLimit && opts.rateLimit.rate > 0 ? new RateLimiter(opts.rateLimit) : undefined;

  // 告警：评估器 + 通知（规则存 DB，面板 CRUD）；notifier 供面板"测试通知"端点使用
  let alertEvaluator: AlertEvaluator | undefined;
  let notifier: ReturnType<typeof createNotifier> | undefined;
  if (opts.alerts) {
    notifier = createNotifier({ defaultWebhookUrl: opts.alerts.defaultWebhookUrl });
    alertEvaluator = createAlertEvaluator({
      aggregatorFor,
      store,
      notifier,
      intervalMs: opts.alerts.evaluateIntervalMs,
    });
    alertEvaluator.start();
  }

  const queryHandler = createApiHandler({ aggregatorFor, store });
  const adminHandler: AdminHandler | undefined = sessions
    ? createAdminHandler({ sessions, store, notifier, logStreamUrlTemplate: opts.logStreamUrlTemplate })
    : undefined;

  // 数据保留：启动先清一次 + 周期清理（unref 定时器，不阻塞进程退出）
  let pruneTimer: NodeJS.Timeout | undefined;
  if (opts.retention && opts.retention.days > 0) {
    const prune = () => {
      try {
        const before = Date.now() - opts.retention!.days * 24 * 3600 * 1000;
        if (opts.retention!.backup) {
          try {
            store.backup(opts.retention!.backupDir || '.aipack/backup');
          } catch (err) {
            console.warn('[observability-server] 数据清理前备份失败:', (err as Error).message);
          }
        }
        const cleared = store.prune(before);
        if (cleared > 0) {
          console.log(
            `[observability-server] 数据清理: 删除 ${cleared} 条过期明细（< ${opts.retention!.days} 天）`,
          );
        }
      } catch (err) {
        console.warn('[observability-server] 数据清理失败:', (err as Error).message);
      }
    };
    if (opts.retention.atStartup !== false) prune();
    pruneTimer = setInterval(prune, opts.retention.intervalMs ?? 3_600_000);
    pruneTimer.unref?.();
  }

  const handler: ApiHandler = async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      const pathname = url.pathname;

      // 面板管理路由（登录公开，其余 Bearer 会话）
      if (
        pathname.startsWith('/api/auth/') ||
        pathname.startsWith('/api/apps') ||
        pathname.startsWith('/api/alerts') ||
        pathname === '/api/meta'
      ) {
        if (!adminHandler) return json(res, 503, { error: 'admin 未启用（缺少 ADMIN_USER/ADMIN_PASS 配置）' });
        return adminHandler(req, res);
      }

      // 客户端埋点上报（appId + appSecret 动态鉴权）
      if (req.method === 'POST' && pathname === '/api/v1/ingest') {
        return handleIngest(req, res, { store, aggregatorFor, limiter });
      }

      // Prometheus 抓取端点：无需登录（只暴露聚合指标），独立于 /metrics/* 面板查询
      if (req.method === 'GET' && pathname === '/metrics/prometheus') {
        res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
        res.end(renderPrometheusMetrics({ aggregatorFor, appIds, windowMs: opts.windowMs }));
        return Promise.resolve();
      }

      // 就绪探针（P2-3）：无鉴权，DB/存储可达则 200，供容器与负载均衡探测
      if (req.method === 'GET' && pathname === '/healthz') {
        try {
          store.listApps();
          return json(res, 200, { ok: true });
        } catch (err) {
          return json(res, 503, { ok: false, error: err instanceof Error ? err.message : 'unavailable' });
        }
      }

      // 查询端点：需要面板会话
      if (req.method === 'GET' && (pathname.startsWith('/metrics/') || pathname.startsWith('/traces'))) {
        if (!sessions || !authenticated(req, sessions)) {
          return json(res, 401, { error: 'unauthorized: 请先登录面板（POST /api/auth/login）' });
        }
        return queryHandler(req, res);
      }

      // 静态文件（面板构建产物）
      if (req.method === 'GET' && opts.staticDir) {
        return serveStatic(url.pathname, opts.staticDir, res);
      }

      return json(res, 404, { error: 'Not Found' });
    } catch (err) {
      return json(res, 500, { error: err instanceof Error ? err.message : 'Internal Error' });
    }
  };

  return {
    handler,
    alerts: alertEvaluator,
    close: async () => {
      if (pruneTimer) clearInterval(pruneTimer);
      alertEvaluator?.stop();
      store.close();
    },
  };
}

// ─── ingest ────────────────────────────────────────────────────────

async function handleIngest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: {
    store: SQLiteStore;
    aggregatorFor(appId?: string): Aggregator;
    limiter?: RateLimiter;
  },
): Promise<void> {
  const appId = header(req, 'x-app-id');
  const secret = header(req, 'x-app-secret');
  if (!appId || !secret || !ctx.store.verifyApp(appId, secret)) {
    return json(res, 401, { error: 'unauthorized: invalid appId or appSecret' });
  }

  // per-appId 限流：超限 429（客户端 HttpReporter 对 429 走缓存补报）
  if (ctx.limiter && !ctx.limiter.check(appId)) {
    return json(res, 429, { error: 'rate limit exceeded' }, { 'Retry-After': '1' });
  }

  let raw = '';
  try {
    raw = await readBody(req);
  } catch (err) {
    return json(res, 400, { error: (err as Error).message });
  }
  let payload: EventBatch & { appId?: string };
  try {
    payload = JSON.parse(raw) as EventBatch & { appId?: string };
  } catch {
    return json(res, 400, { error: 'invalid json body' });
  }
  if (payload.appId !== appId) {
    return json(res, 400, { error: 'body appId mismatch' });
  }

  const batch: EventBatch = {
    runs: Array.isArray(payload.runs) ? payload.runs : [],
    spans: Array.isArray(payload.spans) ? payload.spans : [],
    toolCalls: Array.isArray(payload.toolCalls) ? payload.toolCalls : [],
    permissions: Array.isArray(payload.permissions) ? payload.permissions : [],
    retries: Array.isArray(payload.retries) ? payload.retries : [],
    events: Array.isArray(payload.events) ? payload.events : [],
  };

  // 落盘（app_id 盖戳）+ 喂聚合器（全局 + 该应用），与查询互不影响
  ctx.store.flush(batch, appId);
  ctx.store.touchApp(appId, Date.now());
  const global = ctx.aggregatorFor();
  const appAgg = ctx.aggregatorFor(appId);
  for (const r of batch.runs) {
    global.ingestRun(r);
    appAgg.ingestRun(r);
  }
  for (const s of batch.spans) {
    global.ingestModelCall(s);
    appAgg.ingestModelCall(s);
  }
  for (const t of batch.toolCalls) {
    global.ingestToolCall(t);
    appAgg.ingestToolCall(t);
  }
  for (const p of batch.permissions) {
    global.ingestPermission(p);
    appAgg.ingestPermission(p);
  }
  for (const rt of batch.retries) {
    global.ingestRetry(rt);
    appAgg.ingestRetry(rt);
  }

  return json(res, 200, { ok: true });
}

// ─── 鉴权 / 静态文件 ──────────────────────────────────────────────

function authenticated(req: http.IncomingMessage, sessions: SessionManager): boolean {
  const token = readBearerToken(req);
  return !!token && sessions.verify(token) !== null;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

async function serveStatic(
  pathname: string,
  staticDir: string,
  res: http.ServerResponse,
): Promise<void> {
  // 安全：禁止路径穿越
  const safe = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  let filePath = path.join(staticDir, safe);
  if (filePath === staticDir || filePath === staticDir + '/') {
    filePath = path.join(staticDir, 'index.html');
  }
  try {
    const stat = await fs.stat(filePath);
    if (stat.isDirectory()) filePath = path.join(filePath, 'index.html');
  } catch {
    // 文件不存在 → 回退 index.html（SPA 路由）
    filePath = path.join(staticDir, 'index.html');
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

function header(req: http.IncomingMessage, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => {
      raw += chunk;
      if (raw.length > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

function json(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<void> {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders });
  return new Promise((resolve) => {
    res.end(JSON.stringify(body), () => resolve());
  });
}
