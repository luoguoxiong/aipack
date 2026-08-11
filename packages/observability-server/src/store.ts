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

export class SQLiteStore implements TraceStore, AppStore {
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
