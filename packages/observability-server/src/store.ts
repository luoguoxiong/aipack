/**
 * TraceStore 接口 + SQLiteStore 实现（observability-s2.md §4.3 / 附录 A DDL）。
 *
 * 接口抽象存储：未来可替换为 ElasticsearchStore / OTLP 导出，消费侧零改动。
 * SQLiteStore 用 better-sqlite3（同步 API），落盘由收集端 ingest 批量调用。
 * 记录类型（RunRecord/SpanRecord/ToolCallRecord）来自 @aipack-ai/observability。
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { RunRecord, SpanRecord, ToolCallRecord, EventRecord, RetryRecord, EventBatch } from '@aipack-ai/observability';
import type { AlertMetric, AlertOperator } from './alerts/rules';
import type { VersionMetrics } from './types';

/** 面板应用（appId + appSecret，动态创建，替代静态 OBS_APPS 白名单） */
export interface AppRecord {
  appId: string;
  appSecret: string;
  name: string;
  createdAt: number;
  /** 最近一次成功上报时间（epoch ms）；未上报过为 undefined */
  lastSeenAt?: number;
}

export interface RunQueryFilter {
  since?: number;
  until?: number;
  status?: string;
  model?: string;
  tool?: string;
  sessionKey?: string;
  appId?: string;
  /** 发布版本精确匹配；历史数据 version 为 NULL 时以 'unknown' 匹配 */
  version?: string;
  offset: number;
  limit: number;
}

export interface RunListItem extends RunRecord {
  /** 该 trace 的模型重试次数（spans 表聚合） */
  retries: number;
  /** 上报来源应用（app_id 戳） */
  appId?: string;
}

export interface TraceDetail {
  run: RunRecord;
  spans: SpanRecord[];
  tools: ToolCallRecord[];
  /** P2-1 自定义事件（按时间正序，与 span 时间轴混排） */
  events: EventRecord[];
  /** P2-2 per-attempt 重试明细（按时间正序） */
  retries: RetryRecord[];
}

export interface TraceStore {
  insertRun(r: RunRecord): void;
  insertSpan(s: SpanRecord): void;
  insertToolCall(t: ToolCallRecord): void;
  queryRuns(filter: RunQueryFilter): { total: number; items: RunListItem[] };
  queryTrace(traceId: string): TraceDetail | undefined;
  /** 按版本聚合（DB 直查，非内存窗口），返回按 lastSeenAt 倒序 */
  queryVersionMetrics(filter: { since?: number; until?: number; appId?: string }): VersionMetrics[];
  /** 批量写入（事务），由收集端 ingest 调用；appId 由鉴权头推导并盖戳 */
  flush(batch: EventBatch, appId: string): void;
  /** 删除 started_at 早于 before 的三表明细（事务），返回删除行数 */
  prune(before: number): number;
  /** 全库快照备份（VACUUM INTO），返回备份文件路径 */
  backup(dir: string): string;
  close(): void;
}

/** 应用存储（apps 表）：面板动态管理 appId/appSecret */
export interface AppStore {
  createApp(name: string): AppRecord;
  listApps(): AppRecord[];
  deleteApp(appId: string): boolean;
  getApp(appId: string): AppRecord | undefined;
  /** 校验上报鉴权（appId + appSecret） */
  verifyApp(appId: string, appSecret: string): boolean;
  /** 重置应用密钥，返回新 secret */
  regenerateSecret(appId: string): string | undefined;
  /** 上报成功后刷新 last_seen_at */
  touchApp(appId: string, ts: number): void;
  /** 启动时种入静态白名单（OBS_APPS），已存在则跳过 */
  seedApps(apps: Record<string, string>): void;
}

/** 告警规则（alert_rules 表，面板 CRUD） */
export interface AlertRuleRow {
  id: string;
  name: string;
  /** 缺省 = 全局（所有应用合并） */
  appId?: string;
  metric: AlertMetric;
  operator: AlertOperator; // lt | lte | gt | gte
  threshold: number;
  lookbackMs: number;
  cooldownMs: number;
  webhookUrl?: string;
  /** metric=toolSuccessRate 时目标工具 */
  toolName?: string;
  /** metric=errorClassCount 时目标错误分类 */
  errorClass?: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

/** 告警事件（alert_events 表，触发/恢复历史） */
export interface AlertEventRow {
  id: number;
  ruleId: string;
  ruleName: string;
  appId?: string;
  metric: string;
  operator: string;
  threshold: number;
  value: number;
  status: 'fired' | 'recovered';
  createdAt: number;
}

/** 告警存储（alert_rules / alert_events 表） */
export interface AlertStore {
  listAlertRules(): AlertRuleRow[];
  getAlertRule(id: string): AlertRuleRow | undefined;
  createAlertRule(rule: AlertRuleRow): void;
  updateAlertRule(id: string, patch: Partial<AlertRuleRow>): AlertRuleRow | undefined;
  deleteAlertRule(id: string): boolean;
  insertAlertEvent(ev: Omit<AlertEventRow, 'id'>): void;
  listAlertEvents(opts: {
    offset: number;
    limit: number;
    status?: string;
  }): { total: number; items: AlertEventRow[] };
}

// ─── SQLite 实现 ─────────────────────────────────────────────────

const DDL = `
CREATE TABLE IF NOT EXISTS apps (
  app_id       TEXT PRIMARY KEY,
  app_secret   TEXT NOT NULL,
  name         TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER
);

CREATE TABLE IF NOT EXISTS runs (
  trace_id     TEXT PRIMARY KEY,
  app_id       TEXT,
  started_at   INTEGER,
  ended_at     INTEGER,
  session_key  TEXT,
  channel      TEXT,
  model        TEXT,
  version      TEXT,
  status       TEXT,
  error_class  TEXT,
  turns        INTEGER,
  duration_ms  INTEGER,
  active_ms    INTEGER,
  queued_ms    INTEGER,
  ttft_ms      INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read   INTEGER,
  cache_write  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at);
CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_key);
CREATE INDEX IF NOT EXISTS idx_runs_app ON runs(app_id);

CREATE TABLE IF NOT EXISTS spans (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  trace_id     TEXT NOT NULL,
  app_id       TEXT,
  span_id      TEXT,
  kind         TEXT,
  name         TEXT,
  started_at   INTEGER,
  duration_ms  INTEGER,
  status       TEXT,
  error_class  TEXT,
  attempts     INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read   INTEGER,
  cache_write  INTEGER,
  session_key  TEXT
);
CREATE INDEX IF NOT EXISTS idx_spans_trace ON spans(trace_id);
CREATE INDEX IF NOT EXISTS idx_spans_session ON spans(session_key);
CREATE INDEX IF NOT EXISTS idx_spans_app ON spans(app_id);
CREATE INDEX IF NOT EXISTS idx_spans_started ON spans(started_at);

CREATE TABLE IF NOT EXISTS tool_calls (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  trace_id     TEXT NOT NULL,
  app_id       TEXT,
  span_id      TEXT,
  tool_name    TEXT,
  status       TEXT,
  duration_ms  INTEGER,
  error_class  TEXT
);
CREATE INDEX IF NOT EXISTS idx_tool_calls_trace ON tool_calls(trace_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_app ON tool_calls(app_id);

CREATE TABLE IF NOT EXISTS alert_rules (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  app_id      TEXT,
  metric      TEXT NOT NULL,
  operator    TEXT NOT NULL,
  threshold   REAL NOT NULL,
  lookback_ms INTEGER NOT NULL,
  cooldown_ms INTEGER NOT NULL,
  webhook_url TEXT,
  tool_name   TEXT,
  error_class TEXT,
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS alert_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id     TEXT NOT NULL,
  rule_name   TEXT NOT NULL,
  app_id      TEXT,
  metric      TEXT NOT NULL,
  operator    TEXT NOT NULL,
  threshold   REAL NOT NULL,
  value       REAL NOT NULL,
  status      TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alert_events_created ON alert_events(created_at);
CREATE INDEX IF NOT EXISTS idx_alert_events_rule ON alert_events(rule_id);

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  trace_id    TEXT,
  app_id      TEXT,
  session_key TEXT,
  name        TEXT NOT NULL,
  data        TEXT,
  ts          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_trace ON events(trace_id);
CREATE INDEX IF NOT EXISTS idx_events_app ON events(app_id);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);

CREATE TABLE IF NOT EXISTS retry_attempts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  trace_id    TEXT NOT NULL,
  app_id      TEXT,
  span_id     TEXT,
  provider    TEXT,
  model_id    TEXT,
  attempt     INTEGER,
  error_class TEXT,
  status      INTEGER,
  delay_ms    INTEGER,
  ts          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_retry_trace ON retry_attempts(trace_id);
CREATE INDEX IF NOT EXISTS idx_retry_app ON retry_attempts(app_id);
CREATE INDEX IF NOT EXISTS idx_retry_ts ON retry_attempts(ts);
`;

/** 旧库升级：为 runs/spans/tool_calls 补充 app_id 列（历史数据为 NULL，不参与按应用过滤） */
function ensureAppIdColumns(db: Database.Database): void {
  for (const table of ['runs', 'spans', 'tool_calls']) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'app_id')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN app_id TEXT`);
    }
  }
}

/** 存量库迁移：spans 表补 cache token 列（DDL 已含，旧库需 ALTER） */
function ensureSpanCacheColumns(db: Database.Database): void {
  const cols = db.prepare('PRAGMA table_info(spans)').all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'cache_read')) {
    db.exec('ALTER TABLE spans ADD COLUMN cache_read INTEGER');
  }
  if (!cols.some((c) => c.name === 'cache_write')) {
    db.exec('ALTER TABLE spans ADD COLUMN cache_write INTEGER');
  }
}

/**
 * 存量库迁移：runs 表补 version 列（DDL 已含，旧库需 ALTER；历史数据为 NULL，聚合归入 unknown）。
 * 版本索引在此统一创建（不放进 DDL：旧库无 version 列时 DDL 建索引会失败）。
 */
function ensureVersionColumn(db: Database.Database): void {
  const cols = db.prepare('PRAGMA table_info(runs)').all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'version')) {
    db.exec('ALTER TABLE runs ADD COLUMN version TEXT');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_runs_version ON runs(version)');
}

const RUN_COLS =
  'trace_id, app_id, started_at, ended_at, session_key, channel, model, version, status, error_class, ' +
  'turns, duration_ms, active_ms, queued_ms, ttft_ms, input_tokens, output_tokens, ' +
  'cache_read, cache_write';

const SPAN_COLS =
  'trace_id, app_id, span_id, kind, name, started_at, duration_ms, status, error_class, ' +
  'attempts, input_tokens, output_tokens, cache_read, cache_write, session_key';

const TOOL_COLS = 'trace_id, app_id, span_id, tool_name, status, duration_ms, error_class';

/** better-sqlite3 不接受 undefined 参数，统一转 null */
const n = (v: unknown): unknown => (v === undefined ? null : v);

export class SQLiteStore implements TraceStore, AppStore, AlertStore {
  private db: Database.Database;
  private insertRunStmt: Database.Statement;
  private insertSpanStmt: Database.Statement;
  private insertToolStmt: Database.Statement;
  private insertEventStmt: Database.Statement;
  private insertRetryStmt: Database.Statement;
  private insertTx: (batch: EventBatch, appId: string) => void;

  constructor(dbPath: string) {
    // 自愈：父目录不存在时自动创建（better-sqlite3 不会建目录，默认 .aipack/ 首次启动会缺失）
    if (dbPath !== ':memory:') {
      mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    // 新库（page_count=0）才开启增量 auto_vacuum：存量库改该持久化 pragma 需 VACUUM
    // 才生效，且会改变文件头部，故不自动改（清理后文件不收缩，文档说明手动 VACUUM）
    if (Number(this.db.pragma('page_count', { simple: true })) === 0) {
      this.db.pragma('auto_vacuum = INCREMENTAL');
    }
    this.db.exec(DDL);
    ensureAppIdColumns(this.db);
    ensureSpanCacheColumns(this.db);
    ensureVersionColumn(this.db);

    this.insertRunStmt = this.db.prepare(
      `INSERT INTO runs (${RUN_COLS}) VALUES (${RUN_COLS.split(',').map(() => '?').join(',')})`,
    );
    this.insertSpanStmt = this.db.prepare(
      `INSERT INTO spans (${SPAN_COLS}) VALUES (${SPAN_COLS.split(',').map(() => '?').join(',')})`,
    );
    this.insertToolStmt = this.db.prepare(
      `INSERT INTO tool_calls (${TOOL_COLS}) VALUES (${TOOL_COLS.split(',').map(() => '?').join(',')})`,
    );
    this.insertEventStmt = this.db.prepare(
      `INSERT INTO events (trace_id, app_id, session_key, name, data, ts) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.insertRetryStmt = this.db.prepare(
      `INSERT INTO retry_attempts (trace_id, app_id, span_id, provider, model_id, attempt, error_class, status, delay_ms, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.insertTx = this.db.transaction((batch: EventBatch, appId: string) => {
      for (const r of batch.runs) this.insertRunStmt.run(runArgs(r, appId));
      for (const s of batch.spans) this.insertSpanStmt.run(spanArgs(s, appId));
      for (const t of batch.toolCalls) this.insertToolStmt.run(toolArgs(t, appId));
      for (const e of batch.events) this.insertEventStmt.run(eventArgs(e, appId));
      for (const rt of batch.retries) this.insertRetryStmt.run(retryArgs(rt, appId));
    });
  }

  // ─── 应用管理（apps 表）───────────────────────────────────────

  createApp(name: string): AppRecord {
    const now = Date.now();
    const record: AppRecord = {
      appId: `app_${randomHex(8)}`,
      appSecret: `sk_${randomHex(24)}`,
      name,
      createdAt: now,
    };
    this.db
      .prepare('INSERT INTO apps (app_id, app_secret, name, created_at) VALUES (?, ?, ?, ?)')
      .run(record.appId, record.appSecret, record.name, record.createdAt);
    return record;
  }

  listApps(): AppRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM apps ORDER BY created_at DESC')
      .all() as Array<Record<string, unknown>>;
    return rows.map(rowToApp);
  }

  deleteApp(appId: string): boolean {
    const result = this.db.prepare('DELETE FROM apps WHERE app_id = ?').run(appId);
    return result.changes > 0;
  }

  getApp(appId: string): AppRecord | undefined {
    const row = this.db.prepare('SELECT * FROM apps WHERE app_id = ?').get(appId) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToApp(row) : undefined;
  }

  verifyApp(appId: string, appSecret: string): boolean {
    const app = this.getApp(appId);
    return !!app && safeEqual(app.appSecret, appSecret);
  }

  regenerateSecret(appId: string): string | undefined {
    const secret = `sk_${randomHex(24)}`;
    const result = this.db
      .prepare('UPDATE apps SET app_secret = ? WHERE app_id = ?')
      .run(secret, appId);
    return result.changes > 0 ? secret : undefined;
  }

  touchApp(appId: string, ts: number): void {
    this.db.prepare('UPDATE apps SET last_seen_at = ? WHERE app_id = ?').run(ts, appId);
  }

  seedApps(apps: Record<string, string>): void {
    const stmt = this.db.prepare(
      'INSERT OR IGNORE INTO apps (app_id, app_secret, name, created_at) VALUES (?, ?, ?, ?)',
    );
    const now = Date.now();
    for (const [appId, appSecret] of Object.entries(apps)) {
      if (appId && appSecret) stmt.run(appId, appSecret, appId, now);
    }
  }

  // ─── 明细落盘 ─────────────────────────────────────────────────

  insertRun(r: RunRecord): void {
    this.insertRunStmt.run(runArgs(r, undefined));
  }

  insertSpan(s: SpanRecord): void {
    this.insertSpanStmt.run(spanArgs(s, undefined));
  }

  insertToolCall(t: ToolCallRecord): void {
    this.insertToolStmt.run(toolArgs(t, undefined));
  }

  queryRuns(filter: RunQueryFilter): { total: number; items: RunListItem[] } {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.since !== undefined) {
      where.push('started_at >= ?');
      params.push(filter.since);
    }
    if (filter.until !== undefined) {
      where.push('started_at < ?');
      params.push(filter.until);
    }
    if (filter.status) {
      where.push('status = ?');
      params.push(filter.status);
    }
    if (filter.model) {
      where.push('model = ?');
      params.push(filter.model);
    }
    if (filter.sessionKey) {
      where.push('session_key = ?');
      params.push(filter.sessionKey);
    }
    if (filter.appId) {
      where.push('app_id = ?');
      params.push(filter.appId);
    }
    if (filter.tool) {
      where.push('trace_id IN (SELECT trace_id FROM tool_calls WHERE tool_name = ?)');
      params.push(filter.tool);
    }
    if (filter.version) {
      // version 为 NULL 的历史数据（阶段 1 之前上报）以 'unknown' 归并匹配
      where.push(`COALESCE(version, 'unknown') = ?`);
      params.push(filter.version);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const { c } = this.db
      .prepare(`SELECT COUNT(*) AS c FROM runs ${whereSql}`)
      .get(...params) as { c: number };

    const rows = this.db
      .prepare(
        `SELECT r.*,
          (SELECT COALESCE(SUM(MAX(s.attempts - 1, 0)), 0) FROM spans s
             WHERE s.trace_id = r.trace_id AND s.kind = 'model') AS retries
         FROM runs r ${whereSql} ORDER BY r.started_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, filter.limit, filter.offset) as Array<
      Record<string, unknown> & { retries: number }
    >;

    return { total: c, items: rows.map((r) => rowToRun(r)) };
  }

  queryTrace(traceId: string): TraceDetail | undefined {
    const run = this.db
      .prepare('SELECT * FROM runs WHERE trace_id = ?')
      .get(traceId) as Record<string, unknown> | undefined;
    if (!run) return undefined;
    const spans = this.db
      .prepare('SELECT * FROM spans WHERE trace_id = ? ORDER BY started_at ASC')
      .all(traceId) as Array<Record<string, unknown>>;
    const tools = this.db
      .prepare('SELECT * FROM tool_calls WHERE trace_id = ?')
      .all(traceId) as Array<Record<string, unknown>>;
    const events = this.db
      .prepare('SELECT * FROM events WHERE trace_id = ? ORDER BY ts ASC')
      .all(traceId) as Array<Record<string, unknown>>;
    const retries = this.db
      .prepare('SELECT * FROM retry_attempts WHERE trace_id = ? ORDER BY ts ASC')
      .all(traceId) as Array<Record<string, unknown>>;
    return {
      run: rowToRun(run as Record<string, unknown> & { retries: number }),
      spans: spans.map(rowToSpan),
      tools: tools.map(rowToTool),
      events: events.map(rowToEvent),
      retries: retries.map(rowToRetry),
    };
  }

  /**
   * 按版本聚合（SQLite 直查，非内存窗口）：
   *  - 基础：runs GROUP BY version（requests/successRate/tokens/avgTurns/lastSeenAt）
   *  - 分位数：SQLite 无 percentile 聚合，JS 侧对 duration_ms 排序求值
   *  - 重试率：JOIN model spans（Σ(attempts-1) / 模型调用数）
   *  - 错误分类 / 工具统计：GROUP BY / JOIN tool_calls
   *  version 为 NULL 的历史数据统一归入 'unknown'；返回按 lastSeenAt 倒序。
   */
  queryVersionMetrics(filter: { since?: number; until?: number; appId?: string }): VersionMetrics[] {
    const conds: string[] = [];
    const params: unknown[] = [];
    if (filter.since !== undefined) {
      conds.push('r.started_at >= ?');
      params.push(filter.since);
    }
    if (filter.until !== undefined) {
      conds.push('r.started_at < ?');
      params.push(filter.until);
    }
    if (filter.appId) {
      conds.push('r.app_id = ?');
      params.push(filter.appId);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const versionExpr = `COALESCE(r.version, 'unknown')`;

    // 1. run 级基础聚合
    const runAgg = this.db
      .prepare(
        `SELECT ${versionExpr} AS version,
                COUNT(*) AS requests,
                SUM(CASE WHEN r.status = 'success' AND r.error_class IS NULL THEN 1 ELSE 0 END) AS success,
                SUM(r.turns) AS turns_sum,
                SUM(r.input_tokens + r.output_tokens + COALESCE(r.cache_read, 0) + COALESCE(r.cache_write, 0)) AS tokens,
                MAX(r.started_at) AS last_seen
         FROM runs r ${where}
         GROUP BY ${versionExpr}`,
      )
      .all(...params) as Array<Record<string, unknown>>;

    // 2. 分位数：按版本收集 duration_ms（升序数组）
    const durRows = this.db
      .prepare(
        `SELECT ${versionExpr} AS version, r.duration_ms AS d
         FROM runs r ${where}
         ORDER BY r.duration_ms ASC`,
      )
      .all(...params) as Array<{ version: string; d: number }>;

    // 3. 模型调用 / 重试（JOIN model span；重试口径对齐聚合器 retryRate）
    const modelAgg = this.db
      .prepare(
        `SELECT ${versionExpr} AS version,
                COUNT(*) AS model_calls,
                COALESCE(SUM(MAX(s.attempts - 1, 0)), 0) AS retries
         FROM runs r JOIN spans s ON s.trace_id = r.trace_id AND s.kind = 'model'
         ${where}
         GROUP BY ${versionExpr}`,
      )
      .all(...params) as Array<Record<string, unknown>>;

    // 4. 错误分类
    const errConds = conds.length ? [...conds, 'r.error_class IS NOT NULL'] : ['r.error_class IS NOT NULL'];
    const errRows = this.db
      .prepare(
        `SELECT ${versionExpr} AS version, r.error_class AS cls, COUNT(*) AS c
         FROM runs r WHERE ${errConds.join(' AND ')}
         GROUP BY ${versionExpr}, r.error_class`,
      )
      .all(...params) as Array<{ version: string; cls: string; c: number }>;

    // 5. 工具统计（JOIN tool_calls；blocked/skipped 不计入分母）
    interface ToolAccum {
      calls: number;
      ok: number;
      error: number;
      totalMs: number;
    }
    const toolAccums = new Map<string, Map<string, ToolAccum>>();
    const toolRows = this.db
      .prepare(
        `SELECT ${versionExpr} AS version, t.tool_name AS name, t.status AS status, t.duration_ms AS d
         FROM tool_calls t JOIN runs r ON r.trace_id = t.trace_id
         ${where}`,
      )
      .all(...params) as Array<{ version: string; name: string; status: string; d: number }>;
    for (const row of toolRows) {
      let byName = toolAccums.get(row.version);
      if (!byName) {
        byName = new Map();
        toolAccums.set(row.version, byName);
      }
      const t = byName.get(row.name) ?? { calls: 0, ok: 0, error: 0, totalMs: 0 };
      const isOk = row.status === 'ok';
      const isErr = row.status === 'error';
      if (isOk || isErr) {
        t.calls += 1;
        t.totalMs += Number(row.d);
      }
      if (isOk) t.ok += 1;
      if (isErr) t.error += 1;
      byName.set(row.name, t);
    }

    // ─── 组装 ─────────────────────────────────────────────────────
    const byVersion = new Map<string, VersionMetrics>();
    for (const row of runAgg) {
      const version = String(row.version);
      const requests = Number(row.requests);
      byVersion.set(version, {
        version,
        lastSeenAt: Number(row.last_seen),
        requests,
        successRate: requests > 0 ? round8(Number(row.success) / requests) : 0,
        p50Ms: 0,
        p95Ms: 0,
        p99Ms: 0,
        totalTokens: Number(row.tokens),
        avgTurns: requests > 0 ? round8(Number(row.turns_sum) / requests) : 0,
        retryRate: 0,
        errorClasses: {},
        tools: {},
      });
    }

    // 分位数（JS 侧排序求值，精确而非直方图近似）
    const durByVersion = new Map<string, number[]>();
    for (const row of durRows) {
      const arr = durByVersion.get(row.version) ?? [];
      arr.push(Number(row.d));
      durByVersion.set(row.version, arr);
    }
    for (const [version, arr] of durByVersion) {
      const m = byVersion.get(version);
      if (!m) continue;
      arr.sort((a, b) => a - b);
      m.p50Ms = quantileSorted(arr, 0.5);
      m.p95Ms = quantileSorted(arr, 0.95);
      m.p99Ms = quantileSorted(arr, 0.99);
    }

    for (const row of modelAgg) {
      const m = byVersion.get(String(row.version));
      if (!m) continue;
      const modelCalls = Number(row.model_calls);
      m.retryRate = modelCalls > 0 ? round8(Number(row.retries) / modelCalls) : 0;
    }

    for (const row of errRows) {
      const m = byVersion.get(row.version);
      if (!m) continue;
      m.errorClasses[row.cls] = Number(row.c);
    }

    for (const [version, byName] of toolAccums) {
      const m = byVersion.get(version);
      if (!m) continue;
      const tools: VersionMetrics['tools'] = {};
      for (const [name, t] of byName) {
        tools[name] = {
          calls: t.calls,
          successRate: t.calls > 0 ? round8(t.ok / t.calls) : 0,
          avgMs: t.calls > 0 ? round2(t.totalMs / t.calls) : 0,
          errors: t.error,
        };
      }
      m.tools = tools;
    }

    const out = [...byVersion.values()];
    out.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
    return out;
  }

  flush(batch: EventBatch, appId: string): void {
    if (
      !batch.runs.length &&
      !batch.spans.length &&
      !batch.toolCalls.length &&
      !batch.events.length &&
      !batch.retries.length
    ) {
      return;
    }
    this.insertTx(batch, appId);
  }

  // ─── 数据保留（retention）─────────────────────────────────────

  /** 删除 started_at 早于 before 的三表明细（事务）。按时间走 started_at 索引。
   *  tool_calls 无时间戳字段（ToolCallRecord 未含 startedAt），随其 trace 的
   *  runs 删除而清为孤儿（NOT EXISTS 走 runs 主键 + tool_calls trace 索引）。 */
  prune(before: number): number {
    if (!Number.isFinite(before)) return 0;
    const delRuns = this.db.prepare('DELETE FROM runs WHERE started_at < ?');
    const delSpans = this.db.prepare('DELETE FROM spans WHERE started_at < ?');
    const delOrphanTools = this.db.prepare(
      'DELETE FROM tool_calls WHERE NOT EXISTS (SELECT 1 FROM runs WHERE runs.trace_id = tool_calls.trace_id)',
    );
    const delEvents = this.db.prepare('DELETE FROM events WHERE ts < ?');
    const delRetries = this.db.prepare('DELETE FROM retry_attempts WHERE ts < ?');
    const runTx = this.db.transaction(() => {
      const runs = delRuns.run(before).changes;
      const spans = delSpans.run(before).changes;
      const tools = delOrphanTools.run().changes;
      const events = delEvents.run(before).changes;
      const retries = delRetries.run(before).changes;
      return runs + spans + tools + events + retries;
    });
    const cleared = runTx();
    // 增量回收空闲页（仅新库 auto_vacuum=INCREMENTAL 时生效；存量库为 no-op）
    if (cleared > 0 && Number(this.db.pragma('auto_vacuum', { simple: true })) > 0) {
      this.db.exec('PRAGMA incremental_vacuum(2000)');
    }
    return cleared;
  }

  /** 全库快照备份（VACUUM INTO 到独立文件），返回备份路径 */
  backup(dir: string): string {
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `obs-backup-${Date.now()}.db`);
    this.db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    return file;
  }

  // ─── 告警存储（alert_rules / alert_events）────────────────────

  listAlertRules(): AlertRuleRow[] {
    const rows = this.db
      .prepare('SELECT * FROM alert_rules ORDER BY created_at ASC')
      .all() as Array<Record<string, unknown>>;
    return rows.map(rowToAlertRule);
  }

  getAlertRule(id: string): AlertRuleRow | undefined {
    const row = this.db.prepare('SELECT * FROM alert_rules WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToAlertRule(row) : undefined;
  }

  createAlertRule(rule: AlertRuleRow): void {
    this.db
      .prepare(
        `INSERT INTO alert_rules
           (id, name, app_id, metric, operator, threshold, lookback_ms, cooldown_ms,
            webhook_url, tool_name, error_class, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rule.id, rule.name, n(rule.appId), rule.metric, rule.operator, rule.threshold,
        rule.lookbackMs, rule.cooldownMs, n(rule.webhookUrl), n(rule.toolName),
        n(rule.errorClass), rule.enabled ? 1 : 0, rule.createdAt, rule.updatedAt,
      );
  }

  updateAlertRule(id: string, patch: Partial<AlertRuleRow>): AlertRuleRow | undefined {
    const existing = this.getAlertRule(id);
    if (!existing) return undefined;
    const merged: AlertRuleRow = { ...existing, ...patch, id, updatedAt: Date.now() };
    this.db
      .prepare(
        `UPDATE alert_rules SET
           name = ?, app_id = ?, metric = ?, operator = ?, threshold = ?,
           lookback_ms = ?, cooldown_ms = ?, webhook_url = ?, tool_name = ?,
           error_class = ?, enabled = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        merged.name, n(merged.appId), merged.metric, merged.operator, merged.threshold,
        merged.lookbackMs, merged.cooldownMs, n(merged.webhookUrl), n(merged.toolName),
        n(merged.errorClass), merged.enabled ? 1 : 0, merged.updatedAt, id,
      );
    return this.getAlertRule(id);
  }

  deleteAlertRule(id: string): boolean {
    const result = this.db.prepare('DELETE FROM alert_rules WHERE id = ?').run(id);
    return result.changes > 0;
  }

  insertAlertEvent(ev: Omit<AlertEventRow, 'id'>): void {
    this.db
      .prepare(
        `INSERT INTO alert_events
           (rule_id, rule_name, app_id, metric, operator, threshold, value, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ev.ruleId, ev.ruleName, n(ev.appId), ev.metric, ev.operator, ev.threshold,
        ev.value, ev.status, ev.createdAt,
      );
  }

  listAlertEvents(opts: {
    offset: number;
    limit: number;
    status?: string;
  }): { total: number; items: AlertEventRow[] } {
    const where = opts.status ? 'WHERE status = ?' : '';
    const params = opts.status ? [opts.status] : [];
    const { c } = this.db
      .prepare(`SELECT COUNT(*) AS c FROM alert_events ${where}`)
      .get(...params) as { c: number };
    const rows = this.db
      .prepare(
        `SELECT * FROM alert_events ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, opts.limit, opts.offset) as Array<Record<string, unknown>>;
    return { total: c, items: rows.map(rowToAlertEvent) };
  }

  close(): void {
    this.db.close();
  }
}

// ─── 行 → 记录映射 ───────────────────────────────────────────────

function rowToRun(r: Record<string, unknown>): RunListItem {
  return {
    traceId: String(r.trace_id),
    appId: optStr(r.app_id),
    startedAt: Number(r.started_at),
    endedAt: Number(r.ended_at),
    sessionKey: String(r.session_key),
    channel: optStr(r.channel),
    model: optStr(r.model),
    appVersion: optStr(r.version),
    status: r.status as RunRecord['status'],
    errorClass: optStr(r.error_class),
    turns: Number(r.turns),
    durationMs: Number(r.duration_ms),
    activeMs: Number(r.active_ms),
    queuedMs: Number(r.queued_ms),
    ttftMs: optNum(r.ttft_ms),
    inputTokens: Number(r.input_tokens),
    outputTokens: Number(r.output_tokens),
    cacheRead: optNum(r.cache_read),
    cacheWrite: optNum(r.cache_write),
    retries: Number(r.retries ?? 0),
  };
}

function rowToSpan(r: Record<string, unknown>): SpanRecord {
  return {
    traceId: String(r.trace_id),
    spanId: String(r.span_id),
    kind: r.kind as SpanRecord['kind'],
    name: String(r.name),
    startedAt: Number(r.started_at),
    durationMs: Number(r.duration_ms),
    status: r.status as SpanRecord['status'],
    errorClass: optStr(r.error_class),
    attempts: optNum(r.attempts),
    inputTokens: optNum(r.input_tokens),
    outputTokens: optNum(r.output_tokens),
    cacheRead: optNum(r.cache_read),
    cacheWrite: optNum(r.cache_write),
    sessionKey: optStr(r.session_key),
  };
}

function rowToTool(r: Record<string, unknown>): ToolCallRecord {
  return {
    traceId: String(r.trace_id),
    spanId: String(r.span_id),
    toolName: String(r.tool_name),
    status: r.status as ToolCallRecord['status'],
    durationMs: Number(r.duration_ms),
    errorClass: optStr(r.error_class),
  };
}

function optStr(v: unknown): string | undefined {
  return v === null || v === undefined ? undefined : String(v);
}

function optNum(v: unknown): number | undefined {
  return v === null || v === undefined ? undefined : Number(v);
}

function runArgs(r: RunRecord, appId: string | undefined): unknown[] {
  return [
    r.traceId, n(appId), r.startedAt, r.endedAt, r.sessionKey, n(r.channel), n(r.model),
    n(r.appVersion), r.status, n(r.errorClass), r.turns, r.durationMs, r.activeMs, r.queuedMs,
    n(r.ttftMs), r.inputTokens, r.outputTokens, n(r.cacheRead), n(r.cacheWrite),
  ];
}

function spanArgs(s: SpanRecord, appId: string | undefined): unknown[] {
  return [
    s.traceId, n(appId), s.spanId, s.kind, s.name, s.startedAt, s.durationMs, s.status,
    n(s.errorClass), n(s.attempts), n(s.inputTokens), n(s.outputTokens),
    n(s.cacheRead), n(s.cacheWrite), n(s.sessionKey),
  ];
}

function toolArgs(t: ToolCallRecord, appId: string | undefined): unknown[] {
  return [t.traceId, n(appId), t.spanId, t.toolName, t.status, t.durationMs, n(t.errorClass)];
}

function rowToEvent(r: Record<string, unknown>): EventRecord {
  return {
    traceId: optStr(r.trace_id),
    sessionKey: optStr(r.session_key),
    name: String(r.name),
    data: r.data === null || r.data === undefined ? undefined : safeParseJson(String(r.data)),
    timestamp: Number(r.ts),
  };
}

function eventArgs(e: EventRecord, appId: string | undefined): unknown[] {
  return [
    n(e.traceId), n(appId), n(e.sessionKey), e.name,
    e.data === undefined ? null : JSON.stringify(e.data), e.timestamp,
  ];
}

function rowToRetry(r: Record<string, unknown>): RetryRecord {
  return {
    traceId: String(r.trace_id),
    spanId: optStr(r.span_id),
    provider: optStr(r.provider) ?? '',
    modelId: optStr(r.model_id) ?? '',
    attempt: Number(r.attempt),
    errorClass: optStr(r.error_class),
    status: optNum(r.status),
    delayMs: Number(r.delay_ms),
    timestamp: Number(r.ts),
  };
}

function retryArgs(rt: RetryRecord, appId: string | undefined): unknown[] {
  return [
    rt.traceId, n(appId), n(rt.spanId), n(rt.provider), n(rt.modelId), rt.attempt,
    n(rt.errorClass), n(rt.status), rt.delayMs, rt.timestamp,
  ];
}

function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function rowToApp(r: Record<string, unknown>): AppRecord {
  return {
    appId: String(r.app_id),
    appSecret: String(r.app_secret),
    name: String(r.name),
    createdAt: Number(r.created_at),
    lastSeenAt: optNum(r.last_seen_at),
  };
}

function rowToAlertRule(r: Record<string, unknown>): AlertRuleRow {
  return {
    id: String(r.id),
    name: String(r.name),
    appId: optStr(r.app_id),
    metric: r.metric as AlertMetric,
    operator: r.operator as AlertOperator,
    threshold: Number(r.threshold),
    lookbackMs: Number(r.lookback_ms),
    cooldownMs: Number(r.cooldown_ms),
    webhookUrl: optStr(r.webhook_url),
    toolName: optStr(r.tool_name),
    errorClass: optStr(r.error_class),
    enabled: Number(r.enabled) === 1,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

function rowToAlertEvent(r: Record<string, unknown>): AlertEventRow {
  return {
    id: Number(r.id),
    ruleId: String(r.rule_id),
    ruleName: String(r.rule_name),
    appId: optStr(r.app_id),
    metric: String(r.metric),
    operator: String(r.operator),
    threshold: Number(r.threshold),
    value: Number(r.value),
    status: r.status as AlertEventRow['status'],
    createdAt: Number(r.created_at),
  };
}

/** 密码/密钥恒时比较，防时序侧信道 */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

/** 升序数组线性插值分位数（对齐聚合器直方图的 p50/p95/p99 语义；空数组返回 0） */
function quantileSorted(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (hi === lo) return sorted[lo];
  return sorted[lo] * (hi - pos) + sorted[hi] * (pos - lo);
}

function round8(n: number): number {
  return Math.round(n * 1e8) / 1e8;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
