/**
 * observability-server 宿主入口（dev / start）。
 *
 * 本包已改为纯库：createCollector / createCollectorServer 由宿主自行组装。
 * 此文件为官方自带的组装入口：读取 .env → 按各 Phase 配置组装
 *   业务库 / 监控库 / MQ Producer / 分布式聚合 / 多用户 RBAC / Agent webhook / 模型价格库
 * → createCollector → createCollectorServer → listen。
 *
 * 启动：
 *   pnpm --filter @aipack-ai/observability-server dev          # tsx 直跑 src
 *   pnpm --filter @aipack-ai/observability-server build        # 产出 dist/main.js
 *   pnpm --filter @aipack-ai/observability-server start        # 跑构建产物
 *
 * 配置项见 .env.example 与 src/config.ts 顶部注释。
 */

import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, type CollectorConfig, type TlsConfig } from './config.js';
import {
  createCollector,
  createCollectorServer,
  createBusinessStores,
  createTraceStore,
  createMqProducer,
  createAggregatorFactory,
  JwtSessionManager,
  createAgentWebhook,
  SQLiteModelPriceStore,
  MySQLModelPriceStore,
  MysqlPool,
} from './index.js';
import type { CollectorOptions, TraceStore, ModelPriceStore } from './index.js';

/** 退出清理句柄（按注册逆序执行；collector.close 已含 businessStores/traceStore/mqProducer/aggregator，此处仅补 collector 未托管的资源） */
const cleanup: Array<() => Promise<void>> = [];

async function main(): Promise<void> {
  const cfg = loadConfig();
  // 确保 SQLite 文件所在目录存在（:memory: 无目录）：createBusinessStores/priceStore 早于
  // collector 内部 SQLiteStore 打开连接，此处先行建目录避免 "directory does not exist"
  if (cfg.dbPath !== ':memory:') {
    await mkdir(path.dirname(cfg.dbPath) || '.', { recursive: true });
  }
  const tls = await readTlsCerts(cfg.tls);

  // ── Phase 1：业务库（app / user / project / agentDefinition / acl） ──────────
  const businessStores = await createBusinessStores({
    businessStore: cfg.businessStore.backend,
    sqliteDbPath: cfg.dbPath,
    mysqlUrl: cfg.businessStore.mysqlUrl,
    autoMigrate: cfg.businessStore.autoMigrate,
  });

  // ── Phase 2：监控库（runs / spans / tool_calls） ──────────────────────────
  //   sqlite 后端 createTraceStore 返回 undefined → collector 回落内部 SQLiteStore
  const traceHandle = await createTraceStore({
    traceStore: cfg.traceStore.backend,
    sqliteDbPath: cfg.dbPath,
    clickhouseUrl: cfg.traceStore.clickhouseUrl,
    clickhouseDatabase: cfg.traceStore.clickhouseDatabase,
    clickhouseUsername: cfg.traceStore.clickhouseUsername,
    clickhousePassword: cfg.traceStore.clickhousePassword,
  });
  const traceStore: TraceStore | undefined =
    cfg.traceStore.backend === 'sqlite' ? undefined : traceHandle.traceStore;

  // ── Phase 3：MQ Producer（Kafka 解耦 ingest 与落盘） ─────────────────────
  const mqProducer = createMqProducer({
    enabled: cfg.mq.enabled,
    brokers: cfg.mq.brokers,
    clientId: cfg.mq.clientId,
    topic: cfg.mq.topic,
    dlqTopic: cfg.mq.dlqTopic,
    sasl: cfg.mq.sasl as never, // 与 ingest-worker 同：config 的联合 mechanism 需对齐 kafkajs 的判别联合
    ssl: cfg.mq.ssl,
  });

  // ── Phase 7：分布式聚合（memory 模式不注入，collector 自建进程内聚合，保留 appIds 探测能力） ─
  let aggregatorFactory: CollectorOptions['aggregatorFactory'];
  let aggregatorClose: CollectorOptions['aggregatorClose'];
  if (cfg.aggregator.backend !== 'memory') {
    const agg = createAggregatorFactory({
      backend: cfg.aggregator.backend,
      redisUrl: cfg.aggregator.redisUrl,
      redisKeyPrefix: cfg.aggregator.redisKeyPrefix,
      l1WindowMs: cfg.aggregator.l1WindowMs,
      l2WindowMs: cfg.aggregator.l2WindowMs,
    });
    aggregatorFactory = agg.aggregatorFor;
    aggregatorClose = agg.close;
  }

  // ── Phase 4：多用户 RBAC（JWT access/refresh + Cookie） ───────────────────
  let auth: CollectorOptions['auth'];
  if (cfg.auth.mode === 'multi' && cfg.auth.jwtSecret) {
    const jwt = new JwtSessionManager(
      businessStores.userStore,
      businessStores.aclStore,
      cfg.auth.jwtSecret,
      {
        accessTtlMs: cfg.auth.accessTtlMs,
        refreshTtlMs: cfg.auth.refreshTtlMs,
        secure: cfg.auth.cookieSecure,
        sameSite: cfg.auth.cookieSameSite,
      },
    );
    auth = {
      jwt,
      userStore: businessStores.userStore,
      projectStore: businessStores.projectStore,
      aclStore: businessStores.aclStore,
    };
  }

  // ── Phase 5：Agent 定义生命周期 + webhook（依赖多用户模式） ────────────────
  let agent: CollectorOptions['agent'];
  if (auth) {
    agent = {
      agentDefinitionStore: businessStores.agentDefinitionStore,
      webhook: createAgentWebhook({
        url: cfg.agent.webhookUrl,
        timeoutMs: cfg.agent.webhookTimeoutMs,
      }),
    };
  }

  // ── Phase 6：模型价格库（成本核算；collector.close 不托管，需自行关闭） ────
  const priceHandle = await createModelPriceStoreHandle(cfg);
  cleanup.push(priceHandle.close);

  // ── 组装 CollectorOptions ───────────────────────────────────────────────
  const opts: CollectorOptions = {
    dbPath: cfg.dbPath,
    apps: cfg.seedApps,
    admin: cfg.admin,
    sessionSecret: cfg.sessionSecret,
    staticDir: cfg.staticDir,
    retention: cfg.retention,
    alerts: cfg.alerts,
    rateLimit: cfg.rateLimit,
    logStreamUrlTemplate: cfg.logStreamUrlTemplate,
    businessStores,
    traceStore,
    mqProducer,
    aggregatorFactory,
    aggregatorClose,
    auth,
    agent,
    modelPriceStore: priceHandle.store,
  };

  // ── 启动 HTTP(S) server ──────────────────────────────────────────────────
  const collector = createCollector(opts);
  cleanup.push(() => collector.close());
  const server = createCollectorServer(collector, tls);
  server.listen(cfg.port, () => {
    const proto = tls ? 'https' : 'http';
    console.log(`[observability-server] 监听 ${proto}://0.0.0.0:${cfg.port}`);
    console.log(`  面板: ${proto}://localhost:${cfg.port}/  (登录用户 ${cfg.admin.username})`);
    console.log(`  上报: POST ${proto}://localhost:${cfg.port}/api/v1/ingest`);
    console.log(
      `  业务库: ${cfg.businessStore.backend} | 监控库: ${cfg.traceStore.backend} | 聚合: ${cfg.aggregator.backend} | MQ: ${cfg.mq.enabled ? 'kafka' : 'off'} | 鉴权: ${cfg.auth.mode}`,
    );
  });

  // ── 优雅退出 ───────────────────────────────────────────────────────────
  const shutdown = async (sig: string): Promise<void> => {
    console.log(`\n[observability-server] 收到 ${sig}，正在关闭...`);
    server.close();
    // 强制退出兜底（避免清理句柄挂起导致进程不退出）
    const force = setTimeout(() => {
      console.error('[observability-server] 清理超时，强制退出');
      process.exit(1);
    }, 5000);
    for (let i = cleanup.length - 1; i >= 0; i--) {
      try {
        await cleanup[i]();
      } catch (err) {
        console.error('[observability-server] 清理失败:', (err as Error).message);
      }
    }
    clearTimeout(force);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

/** 创建模型价格库（Phase 6）；返回 store + close。MySQL 模式不加载 better-sqlite3 原生模块。 */
async function createModelPriceStoreHandle(
  cfg: CollectorConfig,
): Promise<{ store: ModelPriceStore; close: () => Promise<void> }> {
  if (cfg.businessStore.backend === 'mysql') {
    if (!cfg.businessStore.mysqlUrl) {
      throw new Error('BUSINESS_STORE=mysql 时必须配置 MYSQL_URL');
    }
    const pool = new MysqlPool(cfg.businessStore.mysqlUrl);
    return {
      store: new MySQLModelPriceStore(pool),
      close: async () => {
        await pool.close();
      },
    };
  }
  // SQLite 模式：懒加载 better-sqlite3（MySQL-only 部署无需编译原生模块）
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(cfg.dbPath);
  db.pragma('journal_mode = WAL');
  return {
    store: new SQLiteModelPriceStore(db),
    close: async () => {
      db.close();
    },
  };
}

/** 读取 TLS 证书（TLS_KEY/TLS_CERT 都配置时启用 HTTPS） */
async function readTlsCerts(
  cfg: TlsConfig | undefined,
): Promise<{ key: Buffer; cert: Buffer } | undefined> {
  if (!cfg) return undefined;
  const [key, cert] = await Promise.all([readFile(cfg.keyPath), readFile(cfg.certPath)]);
  return { key, cert };
}

main().catch((err) => {
  console.error('[observability-server] 启动失败:', err);
  process.exit(1);
});
