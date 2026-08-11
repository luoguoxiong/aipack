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
 *   STATIC_DIR  可选:面板静态文件目录(构建产物)。缺省自动定位到本包 dist/public
 *               (即 `pnpm --filter @aipack/observability-server build` 的产出),
 *               存在则 GET / 直接返回面板
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
 */
import './loadEnv.js'; // 副作用:最先加载 .env(必须在读取 process.env 之前)
import { randomBytes } from 'node:crypto';
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
  /** 面板静态文件目录（可选） */
  staticDir?: string;
  /** 数据保留配置（PRUNE_*） */
  retention: RetentionConfig;
  /** 告警配置（ALERTS_*）；undefined = 告警关闭 */
  alerts?: AlertConfig;
  /** TLS 配置（TLS_KEY/TLS_CERT 均配置时启用 HTTPS） */
  tls?: TlsConfig;
  /** ingest 限流（INGEST_RATE/INGEST_BURST；rate<=0 关闭） */
  rateLimit?: { rate: number; burst: number };
  /** 面板 Trace 详情"查看日志"跳转模板（LOG_STREAM_URL_TEMPLATE，%s 替换 traceId） */
  logStreamUrlTemplate?: string;
}

export function loadConfig(): CollectorConfig {
  const port = Number(process.env.PORT) || 8787;
  const dbPath = process.env.DB_PATH || '.aipack/collector.db';
  const seedApps = parseApps(process.env.OBS_APPS || '');
  const staticDir = process.env.STATIC_DIR || defaultStaticDir();
  const admin = resolveAdmin();
  if (!staticDir) {
    console.log(
      '[observability-server] 未找到面板构建产物(dist/public)。运行 pnpm --filter @aipack/observability-server build 或配置 STATIC_DIR 后即可通过 http://localhost:' +
        port +
        ' 访问面板。',
    );
  }
  return {
    port,
    dbPath,
    seedApps,
    admin,
    staticDir,
    retention: resolveRetention(dbPath),
    alerts: resolveAlerts(),
    tls: resolveTls(),
    rateLimit: resolveRateLimit(),
    logStreamUrlTemplate: process.env.LOG_STREAM_URL_TEMPLATE?.trim() || undefined,
  };
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
function resolveRateLimit(): { rate: number; burst: number } | undefined {
  const rate = Number(process.env.INGEST_RATE);
  if (!Number.isFinite(rate) || rate <= 0) return undefined;
  const burst = Number(process.env.INGEST_BURST);
  return { rate, burst: Number.isFinite(burst) && burst > 0 ? burst : rate * 2 };
}
