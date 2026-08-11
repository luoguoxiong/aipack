/**
 * TraceStore 接口 + SQLiteStore 实现（observability-s2.md §4.3 / 附录 A DDL）。
 *
 * 接口抽象存储：未来可替换为 ElasticsearchStore / OTLP 导出，消费侧零改动。
 * SQLiteStore 用 better-sqlite3（同步 API），落盘由收集端 ingest 批量调用。
 * 记录类型（RunRecord/SpanRecord/ToolCallRecord）来自 @aipack/observability。
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { RunRecord, SpanRecord, ToolCallRecord, EventBatch } from '@aipack/observability';
import type { AlertMetric, AlertOperator } from './alerts/rules';

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
  /** 按应用过滤（apps 表 app_id） */
  appId?: string;
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
}

export interface TraceStore {
  insertRun(r: RunRecord): void;
  insertSpan(s: SpanRecord): void;
  insertToolCall(t: ToolCallRecord): void;
  queryRuns(filter: RunQueryFilter): { total: number; items: RunListItem[] };
  queryTrace(traceId: string): TraceDetail | undefined;
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
  cache_write  INTEGER,
  cost_usd     REAL
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
  cost_usd     REAL,
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

const RUN_COLS =
  'trace_id, app_id, started_at, ended_at, session_key, channel, model, status, error_class, ' +
  'turns, duration_ms, active_ms, queued_ms, ttft_ms, input_tokens, output_tokens, ' +
  'cache_read, cache_write, cost_usd';

const SPAN_COLS =
  'trace_id, app_id, span_id, kind, name, started_at, duration_ms, status, error_class, ' +
  'attempts, input_tokens, output_tokens, cost_usd, session_key';

const TOOL_COLS = 'trace_id, app_id, span_id, tool_name, status, duration_ms, error_class';

/** better-sqlite3 不接受 undefined 参数，统一转 null */
const n = (v: unknown): unknown => (v === undefined ? null : v);

export class SQLiteStore implements TraceStore, AppStore, AlertStore {
  private db: Database.Database;
  private insertRunStmt: Database.Statement;
  private insertSpanStmt: Database.Statement;
  private insertToolStmt: Database.Statement;
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

    this.insertRunStmt = this.db.prepare(
      `INSERT INTO runs (${RUN_COLS}) VALUES (${RUN_COLS.split(',').map(() => '?').join(',')})`,
    );
    this.insertSpanStmt = this.db.prepare(
      `INSERT INTO spans (${SPAN_COLS}) VALUES (${SPAN_COLS.split(',').map(() => '?').join(',')})`,
    );
    this.insertToolStmt = this.db.prepare(
      `INSERT INTO tool_calls (${TOOL_COLS}) VALUES (${TOOL_COLS.split(',').map(() => '?').join(',')})`,
    );
    this.insertTx = this.db.transaction((batch: EventBatch, appId: string) => {
      for (const r of batch.runs) this.insertRunStmt.run(runArgs(r, appId));
      for (const s of batch.spans) this.insertSpanStmt.run(spanArgs(s, appId));
      for (const t of batch.toolCalls) this.insertToolStmt.run(toolArgs(t, appId));
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
    return {
      run: rowToRun(run as Record<string, unknown> & { retries: number }),
      spans: spans.map(rowToSpan),
      tools: tools.map(rowToTool),
    };
  }

  flush(batch: EventBatch, appId: string): void {
    if (!batch.runs.length && !batch.spans.length && !batch.toolCalls.length) return;
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
    const runTx = this.db.transaction(() => {
      const runs = delRuns.run(before).changes;
      const spans = delSpans.run(before).changes;
      const tools = delOrphanTools.run().changes;
      return runs + spans + tools;
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
    costUsd: optNum(r.cost_usd),
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
    costUsd: optNum(r.cost_usd),
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
    r.status, n(r.errorClass), r.turns, r.durationMs, r.activeMs, r.queuedMs,
    n(r.ttftMs), r.inputTokens, r.outputTokens, n(r.cacheRead), n(r.cacheWrite),
    n(r.costUsd),
  ];
}

function spanArgs(s: SpanRecord, appId: string | undefined): unknown[] {
  return [
    s.traceId, n(appId), s.spanId, s.kind, s.name, s.startedAt, s.durationMs, s.status,
    n(s.errorClass), n(s.attempts), n(s.inputTokens), n(s.outputTokens), n(s.costUsd),
    n(s.sessionKey),
  ];
}

function toolArgs(t: ToolCallRecord, appId: string | undefined): unknown[] {
  return [t.traceId, n(appId), t.spanId, t.toolName, t.status, t.durationMs, n(t.errorClass)];
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
