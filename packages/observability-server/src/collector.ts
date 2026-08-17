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
import type { EventBatch } from '@aipack-ai/observability';
import { Aggregator } from './aggregator';
import { createApiHandler, type ApiHandler } from './server';
import { createAdminHandler, type AdminHandler } from './admin';
import { SessionManager, readBearerToken } from './auth';
import { JwtSessionManager } from './auth/jwt';
import { SQLiteStore } from './store';
import { createAlertEvaluator, type AlertEvaluator } from './alerts/evaluator';
import { createNotifier } from './alerts/notify';
import { renderPrometheusMetrics } from './prometheus';
import { RateLimiter, type RateLimitOptions } from './rate-limit';
import type { AppStore } from './stores/app-store';
import type { ModelPriceStore } from './stores/model-price-store';
import type { BusinessStores, TraceStore } from './stores';
import type { MqProducer } from './mq/types';
import { encodeIngestMessage } from './mq/types';
import type { Aggregator as IAggregator, AggregatorFactory } from './aggregator/interface';
import { createUsersHandler, type UsersHandler } from './api/users';
import { createProjectsHandler, type ProjectsHandler } from './api/projects';
import { createAuthHandler, type AuthHandler } from './api/auth';
import {
  createAgentDefinitionsHandler,
  type AgentDefinitionsHandler,
  type AgentWebhook,
} from './api/agent-definitions';
import { authenticate, writeAuthFailure, type AuthContext } from './middleware/auth';
import { createAgentWebhook } from './agent-definition/webhook';

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
  /**
   * 业务 Store 集合（Phase 1）：注入后 app/user/project/agentDefinition/acl
   * 全部走此组 Store（SQLite 或 MySQL）；缺省时 appStore 回落到 SQLiteStore。
   *
   * 由 宿主应用 通过 createBusinessStores() 创建后注入；测试也可直接注入 mock。
   */
  businessStores?: BusinessStores;
  /**
   * 监控 Store（Phase 2）：注入后 runs/spans/tool_calls/events/retries
   * 走此 Store（SQLite / ClickHouse / Dual）；缺省时回落内部 SQLiteStore。
   *
   * 由 宿主应用 通过 createTraceStore() 创建后注入；测试也可直接注入 mock。
   */
  traceStore?: TraceStore;
  /**
   * MQ Producer（Phase 3）：注入后 ingest 不再同步落盘，而是 produce 到 Kafka，
   * 由独立 worker 消费 → TraceStore.flush。
   *
   * 注意：注入 mqProducer 时，aggregator 仍在 collector 本地维护（保证 /metrics/prometheus 可用），
   * 仅"落盘"这一步异步化到 worker。Phase 7 引入 RedisAggregator 后才完全解耦。
   *
   * 由 宿主应用 通过 createMqProducer() 创建后注入；测试也可注入 mock。
   */
  mqProducer?: MqProducer;
  /**
   * Aggregator 工厂（Phase 7）：注入后用 Redis/Hybrid 聚合，支持多实例水平扩展。
   * 缺省时 collector 内部自建进程内 MemoryAggregator（单实例可用，零依赖）。
   *
   * 由 宿主应用 通过 createAggregatorFactory() 创建后注入；测试也可注入 mock。
   * 注意：注入此字段时，opts.windowMs / opts.bucketMs 不再生效（由工厂内部配置）。
   */
  aggregatorFactory?: AggregatorFactory;
  /**
   * Aggregator 工厂的 close 句柄（Phase 7）：用于关闭时释放 Redis 连接。
   * 仅当 aggregatorFactory 由 collector 拥有时传入（cli 创建的工厂）。
   */
  aggregatorClose?: () => Promise<void>;
  /**
   * Phase 4：多用户 RBAC 配置。
   * 注入后启用 /api/users/* /api/projects/* /api/auth/login（multi）路由，
   * 应用管理按项目 + ACL 过滤；缺省时回落单用户模式（ADMIN_USER/ADMIN_PASS）。
   */
  auth?: AuthOptions;
  /**
   * Phase 5：Agent 定义生命周期。注入 agentDefinitionStore 后启用
   * /api/projects/:pid/agents/* 路由；webhook 可选。
   */
  agent?: AgentOptions;
  /**
   * Phase 6：模型价格 Store。注入后启用 /metrics/model-prices CRUD 端点，
   * 供面板"模型价格管理"子页使用；缺省时端点返回 501。
   */
  modelPriceStore?: ModelPriceStore;
}

/** Phase 4：多用户 RBAC 配置 */
export interface AuthOptions {
  /** JWT 会话管理器（cli 通过 userStore + aclStore + jwtSecret 构造） */
  jwt: JwtSessionManager;
  /** 业务 stores（userStore / projectStore / aclStore 来自 businessStores） */
  userStore: BusinessStores['userStore'];
  projectStore: BusinessStores['projectStore'];
  aclStore: BusinessStores['aclStore'];
}

/** Phase 5：Agent 定义配置 */
export interface AgentOptions {
  agentDefinitionStore: BusinessStores['agentDefinitionStore'];
  /** 发布事件 webhook（可选） */
  webhook?: AgentWebhook;
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
  // 业务 Store：注入的 businessStores 优先；缺省回落 SQLiteStore（兼容旧行为）
  const appStore: AppStore = opts.businessStores?.appStore ?? store;
  // 监控 Store：注入的 traceStore 优先；缺省回落 SQLiteStore（兼容旧行为）
  // 注意：注入 traceStore 时，store 仅用于 alert_rules 表（SQLiteStore 仍持有连接）
  const traceStore: TraceStore = opts.traceStore ?? store;
  if (opts.apps) {
    // seedApps 走注入的 appStore（MySQL 模式下种入 MySQL；SQLite 模式种入同库）
    // fire-and-forget：createCollector 是同步函数，seedApps 失败仅打日志不阻塞启动
    appStore.seedApps(opts.apps).catch((err) =>
      console.error('[observability-server] seedApps 失败:', err),
    );
  }

  // 全局聚合（所有应用合并）+ 按应用聚合（面板 appId 过滤）
  // Phase 7：支持注入 aggregatorFactory（Redis/Hybrid）；缺省回退进程内 MemoryAggregator
  let aggregatorFor: (appId?: string) => IAggregator;
  let closeAggregator: (() => Promise<void>) | undefined;
  let byAppForIds: Map<string, IAggregator> | undefined;
  if (opts.aggregatorFactory) {
    aggregatorFor = opts.aggregatorFactory;
    closeAggregator = opts.aggregatorClose;
    // Redis/Hybrid 模式下，已知 appId 由 appStore 维护，appIds() 走 seedApps + appStore.list
    byAppForIds = undefined;
  } else {
    const globalAggregator = new Aggregator({ windowMs: opts.windowMs, bucketMs: opts.bucketMs });
    const byApp = new Map<string, IAggregator>();
    byAppForIds = byApp;
    aggregatorFor = (appId?: string): IAggregator => {
      if (!appId) return globalAggregator;
      let agg = byApp.get(appId);
      if (!agg) {
        agg = new Aggregator({ windowMs: opts.windowMs, bucketMs: opts.bucketMs });
        byApp.set(appId, agg);
      }
      return agg;
    };
    closeAggregator = async () => {
      await globalAggregator.close();
      await Promise.all([...byApp.values()].map((a) => a.close()));
    };
  }

  const sessions = opts.admin
    ? new SessionManager(
        { username: opts.admin.username, password: opts.admin.password },
        { secret: opts.sessionSecret },
      )
    : undefined;

  // Phase 4：多用户模式（注入 opts.auth 时启用），否则单用户模式（向后兼容）
  const isMultiUser = !!opts.auth;
  const authCtx: AuthContext | undefined = opts.auth
    ? {
        multi: {
          sessions: opts.auth.jwt,
          userStore: opts.auth.userStore,
          aclStore: opts.auth.aclStore,
        },
      }
    : undefined;

  // Phase 4/5：构建各 API handler
  const usersHandler: UsersHandler | undefined = opts.auth
    ? createUsersHandler({
        userStore: opts.auth.userStore,
        aclStore: opts.auth.aclStore,
        jwt: opts.auth.jwt,
      })
    : undefined;
  const projectsHandler: ProjectsHandler | undefined = opts.auth
    ? createProjectsHandler({
        userStore: opts.auth.userStore,
        projectStore: opts.auth.projectStore,
        aclStore: opts.auth.aclStore,
        jwt: opts.auth.jwt,
      })
    : undefined;
  // 多用户模式：/api/auth/* 走多用户 auth handler；
  // 单用户模式：/api/auth/login 仍走 admin.ts 的 SessionManager
  const multiAuthHandler: AuthHandler | undefined = opts.auth
    ? createAuthHandler({
        userStore: opts.auth.userStore,
        aclStore: opts.auth.aclStore,
        jwt: opts.auth.jwt,
      })
    : undefined;
  // Phase 5：Agent 定义生命周期 handler
  const agentDefsHandler: AgentDefinitionsHandler | undefined =
    opts.auth && opts.agent
      ? createAgentDefinitionsHandler({
          userStore: opts.auth.userStore,
          agentDefinitionStore: opts.agent.agentDefinitionStore,
          aclStore: opts.auth.aclStore,
          jwt: opts.auth.jwt,
          webhook: opts.agent.webhook,
        })
      : undefined;

  // Phase 4：多用户模式自动 seed admin 用户（与 ADMIN_USER/ADMIN_PASS 对齐）
  // fire-and-forget：createCollector 是同步函数；seed 失败仅打日志不阻塞启动
  if (opts.auth && opts.admin) {
    const adminEmail = opts.admin.username.includes('@')
      ? opts.admin.username
      : `${opts.admin.username}@aipack.local`;
    opts.auth.userStore
      .getUserByEmail(adminEmail)
      .then((existing) => {
        if (existing) return null;
        return opts.auth!.userStore.createUser({
          email: adminEmail,
          password: opts.admin!.password,
          name: opts.admin!.username,
        });
      })
      .then((created) => {
        if (created) {
          console.log(
            `[observability-server] 多用户模式：已 seed admin 用户 ${adminEmail}（密码同 ADMIN_PASS）`,
          );
        }
      })
      .catch((err) =>
        console.error('[observability-server] seed admin 用户失败:', err),
      );
  }

  // 已知应用 id（种子白名单 + 有上报数据的 appId），供 Prometheus 按应用拆分导出
  // memory 模式：byApp Map 已包含所有有聚合数据的 appId
  // redis/hybrid 模式：仅靠 seedApps（appId 由 appStore 维护，Prometheus 导出仅含种子应用）
  const appIds = (): string[] => {
    const ids = new Set<string>(Object.keys(opts.apps ?? {}));
    if (byAppForIds) {
      for (const appId of byAppForIds.keys()) ids.add(appId);
    }
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
      store: traceStore, // Phase 2：监控查询走 traceStore（CH/dual 模式下走 CH）
      alertStore: store, // 告警规则/事件仍存 SQLiteStore（与业务库分离）
      notifier,
      intervalMs: opts.alerts.evaluateIntervalMs,
    });
    alertEvaluator.start();
  }

  const queryHandler = createApiHandler({ aggregatorFor, store: traceStore, modelPriceStore: opts.modelPriceStore });
  // admin handler：单用户模式（sessions）或多用户模式（authCtx）二选一；
  // 多用户模式下 admin.ts 仅处理 /api/apps /api/alerts /api/meta（/api/auth/* 由 api/auth.ts 接管）
  const adminHandler: AdminHandler | undefined =
    sessions || isMultiUser
      ? createAdminHandler({
          sessions: isMultiUser ? undefined : sessions,
          appStore,
          alertStore: store,
          authCtx,
          projectStore: opts.auth?.projectStore,
          notifier,
          logStreamUrlTemplate: opts.logStreamUrlTemplate,
        })
      : undefined;

  // 数据保留：启动先清一次 + 周期清理（unref 定时器，不阻塞进程退出）
  let pruneTimer: NodeJS.Timeout | undefined;
  if (opts.retention && opts.retention.days > 0) {
    const prune = async () => {
      try {
        const before = Date.now() - opts.retention!.days * 24 * 3600 * 1000;
        if (opts.retention!.backup) {
          try {
            await traceStore.backup(opts.retention!.backupDir || '.aipack/backup');
          } catch (err) {
            console.warn('[observability-server] 数据清理前备份失败:', (err as Error).message);
          }
        }
        const cleared = await traceStore.prune(before);
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

      // Phase 4：多用户模式路由（users / projects / 多用户 auth / agents）
      if (isMultiUser) {
        // /api/users/* → usersHandler
        if (pathname.startsWith('/api/users/')) {
          if (!usersHandler) return json(res, 503, { error: 'users API 未启用' });
          return usersHandler(req, res);
        }
        // /api/auth/* → multiAuthHandler（多用户模式接管；单用户仍走 admin.ts）
        if (pathname.startsWith('/api/auth/')) {
          if (!multiAuthHandler) return json(res, 503, { error: '多用户 auth 未启用' });
          return multiAuthHandler(req, res);
        }
        // /api/projects/:pid/agents/* → agentDefsHandler（Phase 5，优先于 /api/projects/* 匹配）
        if (/^\/api\/projects\/[^/]+\/agents(\/|$)/.test(pathname)) {
          if (!agentDefsHandler) return json(res, 503, { error: 'Agent 定义 API 未启用' });
          return agentDefsHandler(req, res);
        }
        // /api/projects/* → projectsHandler
        if (pathname.startsWith('/api/projects')) {
          if (!projectsHandler) return json(res, 503, { error: 'projects API 未启用' });
          return projectsHandler(req, res);
        }
      }

      // 面板管理路由（单用户模式 /api/auth/login；apps/alerts/meta 两模式共用）
      if (
        (sessions && pathname.startsWith('/api/auth/')) ||
        pathname.startsWith('/api/apps') ||
        pathname.startsWith('/api/alerts') ||
        pathname === '/api/meta'
      ) {
        if (!adminHandler) return json(res, 503, { error: 'admin 未启用（缺少 ADMIN_USER/ADMIN_PASS 配置）' });
        return adminHandler(req, res);
      }

      // 客户端埋点上报（appId + appSecret 动态鉴权）
      if (req.method === 'POST' && pathname === '/api/v1/ingest') {
        return handleIngest(req, res, {
          traceStore,
          appStore,
          aggregatorFor,
          limiter,
          mqProducer: opts.mqProducer,
          // Phase 7：注入 aggregatorFactory 即为 redis/hybrid 共享模式
          useSharedAggregator: !!opts.aggregatorFactory,
        });
      }

      // Prometheus 抓取端点：无需登录（只暴露聚合指标），独立于 /metrics/* 面板查询
      if (req.method === 'GET' && pathname === '/metrics/prometheus') {
        res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
        res.end(await renderPrometheusMetrics({ aggregatorFor, appIds, windowMs: opts.windowMs }));
        return Promise.resolve();
      }

      // 就绪探针（P2-3）：无鉴权，DB/存储可达则 200，供容器与负载均衡探测
      if (req.method === 'GET' && pathname === '/healthz') {
        try {
          await store.listApps();
          return json(res, 200, { ok: true });
        } catch (err) {
          return json(res, 503, { ok: false, error: err instanceof Error ? err.message : 'unavailable' });
        }
      }

      // 查询端点：需要面板会话
      if (req.method === 'GET' && (pathname.startsWith('/metrics/') || pathname.startsWith('/traces'))) {
        // 多用户模式：JWT access token（cookie 或 Bearer）
        if (isMultiUser && authCtx) {
          const auth = await authenticate(
            req,
            authCtx,
            true,
            url.searchParams.get('projectId') || undefined,
          );
          if (!auth || !auth.ok) {
            return auth ? writeAuthFailure(res, auth) : json(res, 401, { error: 'unauthorized' });
          }
          return queryHandler(req, res);
        }
        // 单用户模式：Bearer session
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
      await opts.businessStores?.close();
      // 关闭注入的 traceStore（与 store 同实例时避免重复关闭）
      if (opts.traceStore && opts.traceStore !== store) {
        await opts.traceStore.close();
      }
      // 关闭 MQ producer（Phase 3）
      if (opts.mqProducer) {
        await opts.mqProducer.close();
      }
      // 关闭 aggregator（Phase 7：Redis/Hybrid 模式释放连接；memory 模式 no-op）
      if (closeAggregator) {
        await closeAggregator();
      }
      await store.close();
    },
  };
}

// ─── ingest ────────────────────────────────────────────────────────

async function handleIngest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: {
    traceStore: TraceStore;
    appStore: AppStore;
    aggregatorFor(appId?: string): IAggregator;
    limiter?: RateLimiter;
    /** Phase 3：注入后走 Kafka，不调 traceStore.flush；缺省走同步落盘 */
    mqProducer?: MqProducer;
    /** Phase 7：是否使用共享聚合器（redis/hybrid）；true 时 MQ 模式下 collector 不喂聚合器（由 worker 喂） */
    useSharedAggregator?: boolean;
  },
): Promise<void> {
  const appId = header(req, 'x-app-id');
  const secret = header(req, 'x-app-secret');
  if (!appId || !secret || !(await ctx.appStore.verifyApp(appId, secret))) {
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

  // Phase 3：MQ 启用时 produce 到 Kafka（落盘由 worker 异步处理）；否则同步落盘
  if (ctx.mqProducer) {
    const msg = encodeIngestMessage({ appId, batch, ingestedAt: Date.now() });
    ctx.mqProducer.send(msg, { key: appId }).catch((err) => {
      console.error('[observability-server] Kafka produce 失败:', err);
    });
    // MQ 模式下聚合由 worker 统一喂（避免 collector 与 worker 双写聚合）
    // 注意：memory 模式 + MQ 启用时，collector 仍需本地喂聚合（worker 的 memory 实例与 collector 不共享）
  } else {
    // 落盘（app_id 盖戳）+ 喂聚合器（全局 + 该应用），与查询互不影响
    ctx.traceStore.flush(batch, appId).catch((err) => {
      console.error('[observability-server] flush 失败:', err);
    });
  }
  ctx.appStore.touchApp(appId, Date.now()).catch(() => {}); // fire-and-forget：touchApp 失败不影响上报

  // Phase 7：聚合策略
  // - 非 MQ 模式：collector 同步落盘 + 喂聚合器（单实例场景）
  // - MQ + memory 模式：collector 喂本地聚合器（worker 的 memory 不共享，需 collector 自喂）
  // - MQ + redis/hybrid 模式：由 worker 喂聚合器（collector 仅 produce Kafka，避免双写）
  const shouldFeedAggregator = !ctx.mqProducer || !ctx.useSharedAggregator;
  if (shouldFeedAggregator) {
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
