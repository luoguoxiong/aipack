/**
 * apps/observability-server/src/config.ts
 *
 * 环境变量解析:
 *   PORT        收集服务监听端口(默认 8787)
 *   DB_PATH     SQLite 文件路径(默认 ./.aipack/collector.db)
 *   OBS_APPS    可选:启动时种入的 app 白名单,格式 appId:appSecret,多应用逗号分隔
 *               (已存在则跳过;后续应用改由面板动态创建)
 *   ADMIN_USER  面板登录用户名(默认 admin)
 *   ADMIN_PASS  面板登录密码(缺省自动生成并打印,首次启动注意保存)
 *   SESSION_SECRET  面板会话签名 secret(P2-3)。配置后登录 token 改为无状态
 *               HMAC 签名(含过期时间),重启不失效、零文件状态;缺省时若
 *               ADMIN_PASS 为显式配置,则以之派生;两者都缺省(密码自动生成)
 *               时回退内存会话(行为同 P1)
 *   STATIC_DIR  可选:面板静态文件目录(构建产物)。缺省自动定位到本包 dist/public
 *               (即 `pnpm --filter @aipack-ai/observability-server build` 的产出),
 *               存在则 GET / 直接返回面板
 *
 * 业务库（Phase 1）:
 *   BUSINESS_STORE  业务数据存储后端(默认 sqlite;可选 mysql)
 *                    - sqlite: 零依赖,users/projects/agent_definitions/acl 复用 DB_PATH 同库
 *                    - mysql:  走 MySQL 连接池,需配置 MYSQL_URL
 *   MYSQL_URL       MySQL 连接串(BUSINESS_STORE=mysql 时必填)
 *                    如 mysql://aipack:aipackpass@localhost:3306/aipack
 *   MYSQL_AUTO_MIGRATE  启动时自动运行 schema 迁移(默认 true;false 则需手动执行)
 *
 * 监控库（Phase 2）:
 *   TRACE_STORE     监控事件存储后端(默认 sqlite;可选 clickhouse|dual)
 *                    - sqlite:    零依赖,runs/spans/tool_calls 复用 DB_PATH 同库
 *                    - clickhouse: 走 ClickHouse 列式存储,需配置 CLICKHOUSE_URL
 *                    - dual:      SQLite + ClickHouse 双写(迁移期用),读取优先 CH
 *   CLICKHOUSE_URL   ClickHouse HTTP 端点(TRACE_STORE=clickhouse|dual 时必填)
 *                    如 http://localhost:8123
 *   CLICKHOUSE_DB    数据库名(默认 aipack)
 *   CLICKHOUSE_USER  用户名(可选)
 *   CLICKHOUSE_PASSWORD 密码(可选)
 *
 * 消息队列（Phase 3）:
 *   MQ_ENABLED       启用 Kafka 解耦 ingest 与落盘(默认 false)
 *                    - false: collector 同步落盘(行为同 Phase 2)
 *                    - true:  collector 仅鉴权+限流+produce Kafka;独立 worker 消费→CH
 *   KAFKA_BROKERS    broker 列表,逗号分隔(如 host1:9094,host2:9094)
 *                    MQ_ENABLED=true 时必填
 *   KAFKA_CLIENT_ID  客户端标识(默认 aipack-collector)
 *   KAFKA_TOPIC      主 topic(默认 aipack.ingest)
 *   KAFKA_DLQ_TOPIC  死信 topic(默认 aipack.ingest.dlq)
 *   KAFKA_GROUP_ID   worker 消费组(默认 obs-workers;仅 worker 用)
 *   KAFKA_SASL_MECH  SASL 鉴权机制(可选:plain/scram-sha-256/scram-sha-512)
 *   KAFKA_SASL_USER  SASL 用户名
 *   KAFKA_SASL_PASS  SASL 密码
 *   KAFKA_SSL        是否启用 SSL(默认 false)
 *
 * 分布式聚合（Phase 7）:
 *   AGGREGATOR       聚合后端(默认 memory;可选 redis|hybrid)
 *                    - memory: 进程内 Map,单实例可用,零依赖
 *                    - redis:  纯 Redis 聚合,多实例共享,每次查询打 Redis
 *                    - hybrid: L1 本地(1min)+L2 Redis(60min),兼顾性能与一致性(推荐)
 *   REDIS_URL        Redis 连接串(AGGREGATOR=redis|hybrid 时必填)
 *                    如 redis://localhost:6379 或 rediss://(TLS)
 *   REDIS_KEY_PREFIX Key 前缀(默认 aipack:agg:,多租户隔离用)
 *   AGGREGATOR_L1_WINDOW_MS  hybrid L1 微窗口(默认 60000=1min)
 *   AGGREGATOR_L2_WINDOW_MS  redis/hybrid L2 主窗口(默认 3600000=60min)
 *
 * 用户/RBAC（Phase 4）:
 *   AUTH_MODE        鉴权模式(默认 multi;可选 single)
 *                    - single: 保留 ADMIN_USER/ADMIN_PASS 单用户会话(向后兼容)
 *                    - multi:  users/projects/acl 表,JWT access+refresh,HTTP-only cookie
 *   JWT_SECRET       JWT 签名 secret(multi 模式必填)
 *                    缺省时若 SESSION_SECRET 显式配置则复用;若 ADMIN_PASS 显式配置
 *                    则以其派生;都缺省(密码自动生成)时回落 single 模式
 *   JWT_ACCESS_TTL_MS   access token 有效期(默认 15min=900000)
 *   JWT_REFRESH_TTL_MS  refresh token 有效期(默认 7d=604800000)
 *   JWT_COOKIE_SECURE   cookie secure flag(HTTPS 部署启用;默认 false)
 *   JWT_COOKIE_SAMESITE cookie SameSite(默认 lax;可选 strict|none)
 *   AGENT_WEBHOOK_URL   Agent 发布 webhook 全局 URL(Phase 5;可选)
 *   AGENT_WEBHOOK_TIMEOUT_MS  webhook 超时 ms(默认 5000)
 *
 * 数据保留（retention）:
 *   RETENTION_DAYS         明细保留天数(默认 30;<=0 表示禁用清理)
 *   PRUNE_INTERVAL_MS      清理周期 ms(默认 1h)
 *   PRUNE_AT_STARTUP       启动时先清理一次(默认 true)
 *   PRUNE_BACKUP           清理前 VACUUM INTO 快照到备份目录(默认 false)
 *   PRUNE_BACKUP_DIR       备份目录(默认 <DB 所在目录>/backup)
 *
 * 告警（alerting）:
 *   ALERTS_ENABLED             启用告警评估器(默认 true;false 关闭)
 *   ALERTS_EVALUATE_INTERVAL_MS 评估周期 ms(默认 60s)
 *   ALERTS_WEBHOOK_URL         全局默认通知 webhook(规则可覆盖;支持企业微信/Slack/飞书)
 *
 * 限流后端（Phase 3）:
 *   RATE_LIMIT_BACKEND     ingest 限流后端(默认 memory;可选 redis)
 *                          - memory: 进程内 TokenBucket(向后兼容,单实例)
 *                          - redis:   Redis 令牌桶(Lua 原子),多实例共享,需配 Redis
 *   RATE_LIMIT_REDIS_URL  限流 Redis 连接串(backend=redis 时必填)
 *                          缺省时 fallback 到 AGGREGATOR_REDIS_URL / REDIS_URL(与 aggregator 共用)
 */
import './loadEnv.js'; // 副作用:最先加载 .env(必须在读取 process.env 之前)
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface RetentionConfig {
  /** 明细保留天数；<=0 禁用 */
  days: number;
  intervalMs: number;
  atStartup: boolean;
  backup: boolean;
  backupDir: string;
}

export interface AlertConfig {
  evaluateIntervalMs: number;
  defaultWebhookUrl?: string;
}

/** TLS（启用后收集服务以 HTTPS 提供） */
export interface TlsConfig {
  keyPath: string;
  certPath: string;
}

export interface CollectorConfig {
  port: number;
  dbPath: string;
  /** 启动时种入的静态白名单（appId -> appSecret），可为空 */
  seedApps: Record<string, string>;
  /** 面板登录凭证（面板开启条件） */
  admin: { username: string; password: string };
  /** 面板会话签名 secret（可选）：配置后签发无状态 HMAC token，重启不失效 */
  sessionSecret?: string;
  /** 面板静态文件目录（可选） */
  staticDir?: string;
  /** 数据保留配置（PRUNE_*） */
  retention: RetentionConfig;
  /** 告警配置（ALERTS_*）；undefined = 告警关闭 */
  alerts?: AlertConfig;
  /** TLS 配置（TLS_KEY/TLS_CERT 均配置时启用 HTTPS） */
  tls?: TlsConfig;
  /** ingest 限流（INGEST_RATE/INGEST_BURST；rate<=0 关闭） */
  rateLimit?: {
    rate: number;
    burst: number;
    /** Phase 3：限流后端，'memory'（默认，进程内 TokenBucket）/ 'redis'（分布式） */
    backend: 'memory' | 'redis';
    /** Phase 3：Redis 连接串（backend='redis' 时必填，fallback AGGREGATOR_REDIS_URL/REDIS_URL） */
    redisUrl?: string;
  };
  /** 面板 Trace 详情"查看日志"跳转模板（LOG_STREAM_URL_TEMPLATE，%s 替换 traceId） */
  logStreamUrlTemplate?: string;
  /** 业务库配置（Phase 1：BUSINESS_STORE / MYSQL_URL） */
  businessStore: BusinessStoreConfig;
  /** 监控库配置（Phase 2：TRACE_STORE / CLICKHOUSE_URL） */
  traceStore: TraceStoreConfig;
  /** 消息队列配置（Phase 3：MQ_ENABLED / KAFKA_BROKERS） */
  mq: MqConfig;
  /** 分布式聚合配置（Phase 7：AGGREGATOR / REDIS_URL） */
  aggregator: AggregatorRuntimeConfig;
  /** 用户/RBAC 配置（Phase 4：AUTH_MODE / JWT_SECRET） */
  auth: AuthConfig;
  /** Agent 定义配置（Phase 5：webhook 通知） */
  agent: AgentConfig;
}

/** 用户/RBAC 配置（Phase 4） */
export interface AuthConfig {
  /** 鉴权模式：'multi'（默认，JWT 多用户）/ 'single'（ADMIN_USER/ADMIN_PASS 单用户） */
  mode: 'multi' | 'single';
  /** JWT 签名 secret（multi 模式必填） */
  jwtSecret?: string;
  /** access token 有效期 ms（默认 15min） */
  accessTtlMs: number;
  /** refresh token 有效期 ms（默认 7d） */
  refreshTtlMs: number;
  /** cookie secure flag（HTTPS 部署启用） */
  cookieSecure: boolean;
  /** cookie SameSite（默认 lax） */
  cookieSameSite: 'lax' | 'strict' | 'none';
}

/** Agent 定义配置（Phase 5） */
export interface AgentConfig {
  /** 发布事件 webhook 全局 URL（可选；未配置则不通知） */
  webhookUrl?: string;
  /** webhook 超时 ms（默认 5000） */
  webhookTimeoutMs: number;
}

/** 监控库配置（Phase 2） */
export interface TraceStoreConfig {
  /** 后端类型：'sqlite'（默认，零依赖）/ 'clickhouse' / 'dual' */
  backend: 'sqlite' | 'clickhouse' | 'dual';
  /** ClickHouse HTTP 端点（backend='clickhouse'|'dual' 时必填） */
  clickhouseUrl?: string;
  /** ClickHouse 数据库名（默认 aipack） */
  clickhouseDatabase?: string;
  /** ClickHouse 用户名（可选） */
  clickhouseUsername?: string;
  /** ClickHouse 密码（可选） */
  clickhousePassword?: string;
}

/** 业务库配置（Phase 1） */
export interface BusinessStoreConfig {
  /** 后端类型：'sqlite'（默认，零依赖）或 'mysql' */
  backend: 'sqlite' | 'mysql';
  /** MySQL 连接串（backend='mysql' 时必填） */
  mysqlUrl?: string;
  /** 启动时自动运行 MySQL 迁移（默认 true） */
  autoMigrate: boolean;
}

/** 消息队列配置（Phase 3） */
export interface MqConfig {
  /** 是否启用 Kafka 解耦（默认 false：collector 同步落盘） */
  enabled: boolean;
  /** Kafka brokers，如 ['localhost:9094'] */
  brokers: string[];
  /** 客户端 ID（默认 aipack-collector） */
  clientId: string;
  /** 主 topic（默认 aipack.ingest） */
  topic: string;
  /** DLQ topic（默认 aipack.ingest.dlq） */
  dlqTopic: string;
  /** 消费组 ID（默认 obs-workers，仅 worker 用） */
  groupId: string;
  /** SASL 鉴权（可选） */
  sasl?: { mechanism: 'plain' | 'scram-sha-256' | 'scram-sha-512'; username: string; password: string };
  /** 是否启用 SSL（默认 false） */
  ssl: boolean;
}

/** 分布式聚合配置（Phase 7） */
export interface AggregatorRuntimeConfig {
  /** 后端类型：'memory'（默认）/ 'redis' / 'hybrid' */
  backend: 'memory' | 'redis' | 'hybrid';
  /** Redis 连接串（backend=redis|hybrid 时必填） */
  redisUrl?: string;
  /** Redis Key 前缀（默认 aipack:agg:） */
  redisKeyPrefix: string;
  /** hybrid L1 微窗口 ms（默认 60000=1min） */
  l1WindowMs: number;
  /** redis/hybrid L2 主窗口 ms（默认 3600000=60min） */
  l2WindowMs: number;
}

export function loadConfig(): CollectorConfig {
  const port = Number(process.env.PORT) || 8787;
  const dbPath = process.env.DB_PATH || '.aipack/collector.db';
  const seedApps = parseApps(process.env.OBS_APPS || '');
  const staticDir = process.env.STATIC_DIR || defaultStaticDir();
  const admin = resolveAdmin();
  if (!staticDir) {
    console.log(
      '[observability-server] 未找到面板构建产物(dist/public)。运行 pnpm --filter @aipack-ai/observability-server build 或配置 STATIC_DIR 后即可通过 http://localhost:' +
        port +
        ' 访问面板。',
    );
  }
  return {
    port,
    dbPath,
    seedApps,
    admin,
    sessionSecret: resolveSessionSecret(),
    staticDir,
    retention: resolveRetention(dbPath),
    alerts: resolveAlerts(),
    tls: resolveTls(),
    rateLimit: resolveRateLimit(),
    logStreamUrlTemplate: process.env.LOG_STREAM_URL_TEMPLATE?.trim() || undefined,
    businessStore: resolveBusinessStore(),
    traceStore: resolveTraceStore(),
    mq: resolveMq(),
    aggregator: resolveAggregator(),
    auth: resolveAuth(),
    agent: resolveAgent(),
  };
}

/** 解析用户/RBAC 配置（Phase 4：AUTH_MODE / JWT_SECRET） */
function resolveAuth(): AuthConfig {
  const rawMode = (process.env.AUTH_MODE ?? 'multi').toLowerCase();
  // 自动检测：未配置 JWT_SECRET/SESSION_SECRET/ADMIN_PASS 时退化为 single 模式
  const explicitJwt = process.env.JWT_SECRET?.trim();
  const sessionSecret = process.env.SESSION_SECRET?.trim();
  const explicitPass = process.env.ADMIN_PASS?.trim();
  const hasSecret = !!(explicitJwt || sessionSecret || explicitPass);

  let mode: 'multi' | 'single';
  if (rawMode === 'single') {
    mode = 'single';
  } else if (rawMode === 'multi') {
    // multi 模式需有 secret 来源；都缺省（密码自动生成）时退化为 single
    mode = hasSecret ? 'multi' : 'single';
  } else {
    throw new Error(`AUTH_MODE 仅支持 multi / single，当前值: ${rawMode}`);
  }

  let jwtSecret: string | undefined;
  if (mode === 'multi') {
    // JWT_SECRET 优先；其次 SESSION_SECRET；最后由 ADMIN_PASS 派生
    if (explicitJwt) {
      jwtSecret = explicitJwt;
    } else if (sessionSecret) {
      jwtSecret = sessionSecret;
    } else if (explicitPass) {
      jwtSecret = createHash('sha256').update(`aipack-jwt:${explicitPass}`).digest('hex');
    }
  }

  const sameSite = process.env.JWT_COOKIE_SAMESITE?.trim().toLowerCase();
  if (sameSite && sameSite !== 'lax' && sameSite !== 'strict' && sameSite !== 'none') {
    throw new Error(`JWT_COOKIE_SAMESITE 仅支持 lax / strict / none，当前值: ${sameSite}`);
  }

  return {
    mode,
    jwtSecret,
    accessTtlMs: Number(process.env.JWT_ACCESS_TTL_MS) || 15 * 60 * 1000,
    refreshTtlMs: Number(process.env.JWT_REFRESH_TTL_MS) || 7 * 24 * 3600 * 1000,
    cookieSecure: (process.env.JWT_COOKIE_SECURE ?? 'false').toLowerCase() === 'true',
    cookieSameSite: (sameSite as 'lax' | 'strict' | 'none') || 'lax',
  };
}

/** 解析 Agent 定义配置（Phase 5：webhook 通知） */
function resolveAgent(): AgentConfig {
  return {
    webhookUrl: process.env.AGENT_WEBHOOK_URL?.trim() || undefined,
    webhookTimeoutMs: Number(process.env.AGENT_WEBHOOK_TIMEOUT_MS) || 5000,
  };
}

/** 解析分布式聚合配置（AGGREGATOR / REDIS_URL 等） */
function resolveAggregator(): AggregatorRuntimeConfig {
  const backend = (process.env.AGGREGATOR ?? 'memory').toLowerCase() as 'memory' | 'redis' | 'hybrid';
  if (backend !== 'memory' && backend !== 'redis' && backend !== 'hybrid') {
    throw new Error(`AGGREGATOR 仅支持 memory / redis / hybrid，当前值: ${backend}`);
  }
  const redisUrl = process.env.REDIS_URL?.trim();
  if ((backend === 'redis' || backend === 'hybrid') && !redisUrl) {
    throw new Error(`AGGREGATOR=${backend} 时必须配置 REDIS_URL（如 redis://localhost:6379）`);
  }
  return {
    backend,
    redisUrl,
    redisKeyPrefix: process.env.REDIS_KEY_PREFIX?.trim() || 'aipack:agg:',
    l1WindowMs: Number(process.env.AGGREGATOR_L1_WINDOW_MS) || 60 * 1000,
    l2WindowMs: Number(process.env.AGGREGATOR_L2_WINDOW_MS) || 60 * 60 * 1000,
  };
}

/** 解析消息队列配置（MQ_ENABLED / KAFKA_BROKERS 等） */
function resolveMq(): MqConfig {
  const enabled = (process.env.MQ_ENABLED ?? 'false').toLowerCase() === 'true';
  const brokersRaw = process.env.KAFKA_BROKERS?.trim();
  const brokers = brokersRaw ? brokersRaw.split(',').map((s) => s.trim()).filter(Boolean) : [];
  if (enabled && brokers.length === 0) {
    throw new Error('MQ_ENABLED=true 时必须配置 KAFKA_BROKERS（如 localhost:9094 或 host1:9094,host2:9094）');
  }
  const saslMech = process.env.KAFKA_SASL_MECH?.trim().toLowerCase();
  const saslUser = process.env.KAFKA_SASL_USER?.trim();
  const saslPass = process.env.KAFKA_SASL_PASS?.trim();
  let sasl: MqConfig['sasl'];
  if (saslMech && saslUser && saslPass) {
    if (saslMech !== 'plain' && saslMech !== 'scram-sha-256' && saslMech !== 'scram-sha-512') {
      throw new Error(`KAFKA_SASL_MECH 仅支持 plain / scram-sha-256 / scram-sha-512，当前值: ${saslMech}`);
    }
    sasl = { mechanism: saslMech, username: saslUser, password: saslPass };
  }
  return {
    enabled,
    brokers,
    clientId: process.env.KAFKA_CLIENT_ID?.trim() || 'aipack-collector',
    topic: process.env.KAFKA_TOPIC?.trim() || 'aipack.ingest',
    dlqTopic: process.env.KAFKA_DLQ_TOPIC?.trim() || 'aipack.ingest.dlq',
    groupId: process.env.KAFKA_GROUP_ID?.trim() || 'obs-workers',
    sasl,
    ssl: (process.env.KAFKA_SSL ?? 'false').toLowerCase() === 'true',
  };
}

/** 解析监控库配置（TRACE_STORE / CLICKHOUSE_URL 等） */
function resolveTraceStore(): TraceStoreConfig {
  const backend = (process.env.TRACE_STORE ?? 'sqlite').toLowerCase();
  if (backend !== 'sqlite' && backend !== 'clickhouse' && backend !== 'dual') {
    throw new Error(`TRACE_STORE 仅支持 'sqlite' / 'clickhouse' / 'dual'，当前值: ${backend}`);
  }
  const clickhouseUrl = process.env.CLICKHOUSE_URL?.trim();
  if ((backend === 'clickhouse' || backend === 'dual') && !clickhouseUrl) {
    throw new Error(`TRACE_STORE=${backend} 时必须配置 CLICKHOUSE_URL（如 http://localhost:8123）`);
  }
  return {
    backend,
    clickhouseUrl,
    clickhouseDatabase: process.env.CLICKHOUSE_DB?.trim() || 'aipack',
    clickhouseUsername: process.env.CLICKHOUSE_USER?.trim() || undefined,
    clickhousePassword: process.env.CLICKHOUSE_PASSWORD?.trim() || undefined,
  };
}

/** 解析业务库配置（BUSINESS_STORE / MYSQL_URL / MYSQL_AUTO_MIGRATE） */
function resolveBusinessStore(): BusinessStoreConfig {
  const backend = (process.env.BUSINESS_STORE ?? 'sqlite').toLowerCase();
  if (backend !== 'sqlite' && backend !== 'mysql') {
    throw new Error(`BUSINESS_STORE 仅支持 'sqlite' 或 'mysql'，当前值: ${backend}`);
  }
  const mysqlUrl = process.env.MYSQL_URL?.trim();
  if (backend === 'mysql' && !mysqlUrl) {
    throw new Error('BUSINESS_STORE=mysql 时必须配置 MYSQL_URL（如 mysql://user:pass@host:3306/db）');
  }
  const autoMigrate = (process.env.MYSQL_AUTO_MIGRATE ?? 'true').toLowerCase() !== 'false';
  return { backend, mysqlUrl, autoMigrate };
}

/**
 * 定位本包内嵌面板的构建产物目录：
 * 优先显式 STATIC_DIR；缺省时在 dist/public（构建产物）与 web 上级目录中探测。
 */
function defaultStaticDir(): string | undefined {
  const candidates = [
    // dev(tsx 跑 src)：packages/observability-server/src/config.ts → ../../dist/public
    fileURLToPath(new URL('../../dist/public/', import.meta.url)),
    // 构建产物：packages/observability-server/dist/config.js → ../dist/public
    fileURLToPath(new URL('../dist/public/', import.meta.url)),
  ];
  return candidates.find((p) => existsSync(p));
}

/** 解析面板登录凭证；ADMIN_PASS 缺省自动生成（多层容错：显式配置 > 自动生成） */
function resolveAdmin(): { username: string; password: string } {
  const username = (process.env.ADMIN_USER || 'admin').trim();
  let password = process.env.ADMIN_PASS;
  if (!password) {
    password = `aipack-${randomBytes(6).toString('hex')}`;
    console.log(
      `[observability-server] 未配置 ADMIN_PASS，已自动生成面板密码：${password}\n` +
        '  → 面板地址 http://localhost:' +
        (process.env.PORT || 8787) +
        ' ，用户名 ' +
        username,
    );
  }
  return { username, password };
}

/**
 * 面板会话签名 secret（P2-3）：显式 SESSION_SECRET 优先；缺省时若 ADMIN_PASS
 * 为显式配置则以其派生（重启后 token 仍有效）；两者都缺省（密码为自动生成）时
 * 返回 undefined → 保留内存会话模式（行为同 P1）。
 */
function resolveSessionSecret(): string | undefined {
  const explicit = process.env.SESSION_SECRET?.trim();
  if (explicit) return explicit;
  const explicitPass = process.env.ADMIN_PASS?.trim();
  if (explicitPass) {
    return createHash('sha256').update(`aipack-session:${explicitPass}`).digest('hex');
  }
  return undefined;
}

/** 解析 "app1:secret1,app2:secret2" → { app1: 'secret1', app2: 'secret2' } */
export function parseApps(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of raw.split(',')) {
    const idx = part.indexOf(':');
    if (idx <= 0) continue;
    const appId = part.slice(0, idx).trim();
    const secret = part.slice(idx + 1).trim();
    if (appId && secret) out[appId] = secret;
  }
  return out;
}

/** 解析数据保留配置（RETENTION_*） */
function resolveRetention(dbPath: string): RetentionConfig {
  const days = Number(process.env.RETENTION_DAYS);
  return {
    days: Number.isFinite(days) ? days : 30,
    intervalMs: Number(process.env.PRUNE_INTERVAL_MS) || 3_600_000,
    atStartup: (process.env.PRUNE_AT_STARTUP ?? 'true').toLowerCase() !== 'false',
    backup: (process.env.PRUNE_BACKUP ?? 'false').toLowerCase() === 'true',
    backupDir:
      process.env.PRUNE_BACKUP_DIR ||
      (dbPath === ':memory:' ? '.aipack/backup' : path.join(path.dirname(dbPath), 'backup')),
  };
}

/** 解析告警配置（ALERTS_*）；ALERTS_ENABLED=false 时返回 undefined（关闭评估器） */
function resolveAlerts(): AlertConfig | undefined {
  if ((process.env.ALERTS_ENABLED ?? 'true').toLowerCase() === 'false') return undefined;
  const evaluateIntervalMs = Number(process.env.ALERTS_EVALUATE_INTERVAL_MS);
  const webhook = process.env.ALERTS_WEBHOOK_URL?.trim();
  return {
    evaluateIntervalMs: Number.isFinite(evaluateIntervalMs) && evaluateIntervalMs > 0 ? evaluateIntervalMs : 60_000,
    defaultWebhookUrl: webhook || undefined,
  };
}

/** 解析 TLS（TLS_KEY/TLS_CERT 两个路径都存在才启用 HTTPS） */
function resolveTls(): TlsConfig | undefined {
  const keyPath = process.env.TLS_KEY?.trim();
  const certPath = process.env.TLS_CERT?.trim();
  if (!keyPath || !certPath) return undefined;
  return { keyPath, certPath };
}

/** 解析 ingest 限流（INGEST_RATE/INGEST_BURST；rate<=0 关闭） */
function resolveRateLimit():
  | { rate: number; burst: number; backend: 'memory' | 'redis'; redisUrl?: string }
  | undefined {
  const rate = Number(process.env.INGEST_RATE);
  if (!Number.isFinite(rate) || rate <= 0) return undefined;
  const burst = Number(process.env.INGEST_BURST);
  const backendRaw = (process.env.RATE_LIMIT_BACKEND ?? 'memory').toLowerCase();
  if (backendRaw !== 'memory' && backendRaw !== 'redis') {
    throw new Error(`RATE_LIMIT_BACKEND 仅支持 memory / redis，当前值: ${backendRaw}`);
  }
  const backend = backendRaw as 'memory' | 'redis';
  // redisUrl fallback：RATE_LIMIT_REDIS_URL → AGGREGATOR_REDIS_URL → REDIS_URL
  const redisUrl = (
    process.env.RATE_LIMIT_REDIS_URL ??
    process.env.AGGREGATOR_REDIS_URL ??
    process.env.REDIS_URL
  )?.trim();
  if (backend === 'redis' && !redisUrl) {
    throw new Error(
      'RATE_LIMIT_BACKEND=redis 时必须配置 RATE_LIMIT_REDIS_URL（或 AGGREGATOR_REDIS_URL / REDIS_URL）',
    );
  }
  return {
    rate,
    burst: Number.isFinite(burst) && burst > 0 ? burst : rate * 2,
    backend,
    redisUrl,
  };
}
