/**
 * ClickHouseStore — 实现 TraceStore 接口（异步版本）。
 *
 * 列式存储，适合亿级 Trace 检索与高基数聚合。
 * - 写入：JSONEachRow 批量 INSERT（SDK 已批量上报，直接透传）
 * - 查询：CH SQL（quantile() 聚合，无需 JS 侧排序）
 * - TTL：表级 90 天自动清理（DDL 含，无需 prune）
 * - 备份：CH 自身 BACKUP 命令（此实现 no-op，由运维侧配置）
 *
 * 与 SQLiteStore 的差异：
 * - 所有方法异步（CH 是远程 HTTP 调用）
 * - queryVersionMetrics 用 CH quantile() 直查，无 JS 排序
 * - prune 走 ALTER TABLE DELETE（CH 异步 mutation）
 * - backup no-op（CH 用 BACKUP 命令，运维侧配置）
 *
 * DDL 见 infra/clickhouse/init.sql
 */

import type {
  RunRecord,
  SpanRecord,
  ToolCallRecord,
  EventRecord,
  RetryRecord,
  EventBatch,
} from '@aipack-ai/observability';
import type { VersionMetrics, VersionToolStat } from '../types';
import type {
  TraceStore,
  RunQueryFilter,
  RunListItem,
  TraceDetail,
  ErrorClassCountItem,
  ErrorClassDrillResult,
  ErrorClassFilter,
} from '../store';
import {
  ClickHouseClient,
  toChDateTime,
  RUN_STATUS_INDEX,
  SPAN_STATUS_INDEX,
  TOOL_STATUS_INDEX,
} from './clickhouse-client';

// 重新导出 ClickHouseClient（供外部使用）
export { ClickHouseClient } from './clickhouse-client';

export interface ClickHouseStoreOptions {
  /** ClickHouse HTTP 端点，如 http://localhost:8123 */
  url: string;
  /** 数据库名，默认 aipack */
  database?: string;
  /** 用户名 */
  username?: string;
  /** 密码 */
  password?: string;
  /** 请求超时 ms（默认 30000） */
  timeoutMs?: number;
}

/** Phase 8：冷归档阈值（与 CH 表 TTL 90 天对齐，超过此阈值的数据路由到 trace_archive） */
const ARCHIVE_THRESHOLD_MS = 90 * 24 * 60 * 60 * 1000;

export class ClickHouseStore implements TraceStore {
  private client: ClickHouseClient;

  constructor(opts: ClickHouseStoreOptions) {
    this.client = new ClickHouseClient(opts);
  }

  /** 健康检查 */
  async ping(): Promise<boolean> {
    return this.client.ping();
  }

  /** 初始化：确保表存在（DDL 见 infra/clickhouse/init.sql，此处仅幂等检查） */
  async ensureSchema(): Promise<void> {
    // 表由 infra/clickhouse/init.sql 创建；此处仅 ping 验证连通
    const ok = await this.client.ping();
    if (!ok) throw new Error('ClickHouse 不可达，请检查 CLICKHOUSE_URL');
  }

  // ─── 单条插入（调试用；生产走 flush 批量） ──────────────────────

  async insertRun(r: RunRecord): Promise<void> {
    await this.client.insert('runs', [runToRow(r, undefined)]);
  }

  async insertSpan(s: SpanRecord): Promise<void> {
    await this.client.insert('spans', [spanToRow(s, undefined)]);
  }

  async insertToolCall(t: ToolCallRecord): Promise<void> {
    await this.client.insert('tool_calls', [toolToRow(t, undefined)]);
  }

  // ─── 批量写入（collector ingest 调用） ──────────────────────────

  async flush(batch: EventBatch, appId: string): Promise<void> {
    const tasks: Promise<void>[] = [];

    if (batch.runs.length) {
      tasks.push(
        this.client.insert(
          'runs',
          batch.runs.map((r) => runToRow(r, appId)),
        ),
      );
    }
    if (batch.spans.length) {
      tasks.push(
        this.client.insert(
          'spans',
          batch.spans.map((s) => spanToRow(s, appId)),
        ),
      );
    }
    if (batch.toolCalls.length) {
      tasks.push(
        this.client.insert(
          'tool_calls',
          batch.toolCalls.map((t) => toolToRow(t, appId)),
        ),
      );
    }
    if (batch.events.length) {
      tasks.push(
        this.client.insert(
          'events',
          batch.events.map((e) => eventToRow(e, appId)),
        ),
      );
    }
    if (batch.retries.length) {
      tasks.push(
        this.client.insert(
          'retry_attempts',
          batch.retries.map((r) => retryToRow(r, appId)),
        ),
      );
    }

    // 并行批量写入各表（CH 表间无事务依赖）
    await Promise.all(tasks);
  }

  // ─── 查询 ────────────────────────────────────────────────────────

  async queryRuns(filter: RunQueryFilter): Promise<{ total: number; items: RunListItem[] }> {
    // Phase 8：热冷路由 — since 距今超过 90 天时查 trace_archive
    const now = Date.now();
    const boundary = now - ARCHIVE_THRESHOLD_MS;
    const needCold = filter.since !== undefined && filter.since < boundary;
    const needHot = filter.until === undefined || filter.until > boundary;

    if (needCold && needHot) {
      // 跨热冷边界：分别查两表再合并（合并后在 JS 侧重新排序分页）
      const coldFilter: RunQueryFilter = { ...filter, until: boundary };
      const hotFilter: RunQueryFilter = { ...filter, since: boundary };
      const [coldItems, hotItems, coldCount, hotCount] = await Promise.all([
        this.listRunsFromTable('trace_archive', coldFilter),
        this.listRunsFromTable('runs', hotFilter),
        this.countRunsFromTable('trace_archive', coldFilter),
        this.countRunsFromTable('runs', hotFilter),
      ]);
      const all = [...coldItems, ...hotItems].sort((a, b) => b.startedAt - a.startedAt);
      const total = coldCount + hotCount;
      const items = all.slice(filter.offset, filter.offset + filter.limit);
      return { total, items };
    }

    const table = needCold ? 'trace_archive' : 'runs';
    const where = buildRunWhere(filter);

    // CH 用字符串插值（已转义；params 来自服务端鉴权后的过滤，非用户输入）
    const countSql = `SELECT count() AS c FROM ${table} r ${where}`;
    const countRows = await this.client.query<{ c: number }>(countSql);
    const total = countRows[0]?.c ?? 0;

    const listSql = `
      SELECT r.*,
        (SELECT sum(greatest(s.attempts - 1, 0)) FROM spans s
         WHERE s.trace_id = r.trace_id AND s.kind = 'model') AS retries
      FROM ${table} r ${where}
      ORDER BY r.started_at DESC
      LIMIT ${Number(filter.limit)} OFFSET ${Number(filter.offset)}
    `;
    const rows = await this.client.query<Record<string, unknown>>(listSql);
    return { total, items: rows.map(chRowToRun) };
  }

  /** 查询指定表的行数（Phase 8：热冷路由辅助） */
  private async countRunsFromTable(table: string, filter: RunQueryFilter): Promise<number> {
    const where = buildRunWhere(filter);
    const countRows = await this.client.query<{ c: number }>(
      `SELECT count() AS c FROM ${table} r ${where}`,
    );
    return Number(countRows[0]?.c ?? 0);
  }

  /** 查询指定表的全部匹配行（不分页，Phase 8 跨边界合并用） */
  private async listRunsFromTable(
    table: string,
    filter: RunQueryFilter,
  ): Promise<RunListItem[]> {
    const where = buildRunWhere(filter);
    const listSql = `
      SELECT r.*,
        (SELECT sum(greatest(s.attempts - 1, 0)) FROM spans s
         WHERE s.trace_id = r.trace_id AND s.kind = 'model') AS retries
      FROM ${table} r ${where}
      ORDER BY r.started_at DESC
    `;
    const rows = await this.client.query<Record<string, unknown>>(listSql);
    return rows.map(chRowToRun);
  }

  async queryTrace(traceId: string): Promise<TraceDetail | undefined> {
    const runRows = await this.client.query<Record<string, unknown>>(
      `SELECT * FROM runs WHERE trace_id = ${chStr(traceId)} LIMIT 1`,
    );
    if (runRows.length === 0) return undefined;
    const run = runRows[0];

    const [spans, tools, events, retries] = await Promise.all([
      this.client.query<Record<string, unknown>>(
        `SELECT * FROM spans WHERE trace_id = ${chStr(traceId)} ORDER BY started_at ASC`,
      ),
      this.client.query<Record<string, unknown>>(
        `SELECT * FROM tool_calls WHERE trace_id = ${chStr(traceId)}`,
      ),
      this.client.query<Record<string, unknown>>(
        `SELECT * FROM events WHERE trace_id = ${chStr(traceId)} ORDER BY ts ASC`,
      ),
      this.client.query<Record<string, unknown>>(
        `SELECT * FROM retry_attempts WHERE trace_id = ${chStr(traceId)} ORDER BY ts ASC`,
      ),
    ]);

    return {
      run: chRowToRun({ ...run, retries: 0 }),
      spans: spans.map(chRowToSpan),
      tools: tools.map(chRowToTool),
      events: events.map(chRowToEvent),
      retries: retries.map(chRowToRetry),
    };
  }

  async queryVersionMetrics(filter: {
    since?: number;
    until?: number;
    appId?: string;
  }): Promise<VersionMetrics[]> {
    const where = buildVersionWhere(filter);

    // CH 单查询聚合所有维度（quantile() 直查，无 JS 排序）
    const sql = `
      SELECT
        ifNull(r.version, 'unknown') AS version,
        count() AS requests,
        countIf(r.status = 'success' AND r.error_class = '') AS success,
        sum(r.turns) AS turns_sum,
        sum(r.input_tokens + r.output_tokens + ifNull(r.cache_read, 0) + ifNull(r.cache_write, 0)) AS tokens,
        max(r.started_at) AS last_seen,
        quantile(0.50)(r.duration_ms) AS p50,
        quantile(0.95)(r.duration_ms) AS p95,
        quantile(0.99)(r.duration_ms) AS p99,
        -- 重试率：Σ(max(attempts-1,0)) / 模型调用数
        ifNull(
          (SELECT sum(greatest(s.attempts - 1, 0)) FROM spans s
           WHERE s.trace_id = r.trace_id AND s.kind = 'model')
          /
          nullIf((SELECT count() FROM spans s2
                  WHERE s2.trace_id = r.trace_id AND s2.kind = 'model'), 0),
          0
        ) AS retry_rate
      FROM runs r ${where}
      GROUP BY version
      ORDER BY last_seen DESC
    `;
    const aggRows = await this.client.query<Record<string, unknown>>(sql);

    // 错误分类（单独查询，按 version + error_class 分组）
    const errSql = `
      SELECT ifNull(version, 'unknown') AS version, error_class AS cls, count() AS c
      FROM runs
      WHERE ${filter.appId ? `app_id = ${chStr(filter.appId)} AND ` : ''}error_class != ''
      ${filter.since !== undefined ? `AND started_at >= toDateTime64(${Number(filter.since) / 1000}, 3)` : ''}
      ${filter.until !== undefined ? `AND started_at < toDateTime64(${Number(filter.until) / 1000}, 3)` : ''}
      GROUP BY version, error_class
    `;
    const errRows = await this.client.query<{ version: string; cls: string; c: number }>(errSql);

    // 工具统计（JOIN tool_calls）
    const toolSql = `
      SELECT
        ifNull(r.version, 'unknown') AS version,
        t.tool_name AS name,
        countIf(t.status = 'ok' OR t.status = 'error') AS calls,
        countIf(t.status = 'ok') AS ok,
        countIf(t.status = 'error') AS error,
        avgIf(t.duration_ms, t.status = 'ok' OR t.status = 'error') AS avg_ms
      FROM tool_calls t
      INNER JOIN runs r ON r.trace_id = t.trace_id
      ${where}
      GROUP BY version, name
    `;
    const toolRows = await this.client.query<{
      version: string;
      name: string;
      calls: number;
      ok: number;
      error: number;
      avg_ms: number;
    }>(toolSql);

    // 组装
    const errorClassesByVersion = new Map<string, Record<string, number>>();
    for (const row of errRows) {
      const m = errorClassesByVersion.get(row.version) ?? {};
      m[row.cls] = Number(row.c);
      errorClassesByVersion.set(row.version, m);
    }

    const toolsByVersion = new Map<string, Record<string, VersionToolStat>>();
    for (const row of toolRows) {
      const m = toolsByVersion.get(row.version) ?? {};
      const calls = Number(row.calls);
      m[row.name] = {
        calls,
        successRate: calls > 0 ? round8(Number(row.ok) / calls) : 0,
        avgMs: Number(row.avg_ms) || 0,
        errors: Number(row.error),
      };
      toolsByVersion.set(row.version, m);
    }

    const result: VersionMetrics[] = aggRows.map((row) => {
      const version = String(row.version);
      const requests = Number(row.requests);
      return {
        version,
        lastSeenAt: Number(row.last_seen),
        requests,
        successRate: requests > 0 ? round8(Number(row.success) / requests) : 0,
        p50Ms: Math.round(Number(row.p50)),
        p95Ms: Math.round(Number(row.p95)),
        p99Ms: Math.round(Number(row.p99)),
        totalTokens: Number(row.tokens),
        avgTurns: requests > 0 ? round8(Number(row.turns_sum) / requests) : 0,
        retryRate: round8(Number(row.retry_rate)),
        errorClasses: errorClassesByVersion.get(version) ?? {},
        tools: toolsByVersion.get(version) ?? {},
      };
    });

    return result;
  }

  // ─── 数据保留 / 备份 ─────────────────────────────────────────────

  /**
   * CH 用 ALTER TABLE DELETE（异步 mutation）。
   * 注意：CH 表已有 TTL 90d 自动清理，此方法仅用于手动清理特定时间点之前的数据。
   * 返回 0（CH mutation 异步执行，无法立即获知删除行数）。
   */
  async prune(before: number): Promise<number> {
    if (!Number.isFinite(before)) return 0;
    const ts = toChDateTime(before);
    await Promise.all([
      this.client.exec(`ALTER TABLE runs DELETE WHERE started_at < '${ts}'`),
      this.client.exec(`ALTER TABLE spans DELETE WHERE started_at < '${ts}'`),
      this.client.exec(`ALTER TABLE events DELETE WHERE ts < '${ts}'`),
      this.client.exec(`ALTER TABLE retry_attempts DELETE WHERE ts < '${ts}'`),
      // tool_calls 无 started_at 列（由 init.sql 中用 span 推导），随 runs TTL 清理
    ]);
    return 0;
  }

  /**
   * CH 备份走 BACKUP 命令（运维侧配置），此实现 no-op。
   * 调用方应配置 CH 自身的备份策略（如 S3 备份）。
   */
  async backup(_dir: string): Promise<string> {
    // ClickHouse 备份由运维侧配置（BACKUP TABLE TO S3），此处不实现
    return '';
  }

  // ─── Phase 9：错误归因下钻 ─────────────────────────────────────

  async queryErrorClassCounts(filter: ErrorClassFilter): Promise<ErrorClassCountItem[]> {
    const where = this.buildChWhere(filter);
    const rows = await this.client.query<{ error_class: string; c: string | number }>(
      `SELECT error_class, count() AS c FROM runs ${where} AND error_class != ''
       GROUP BY error_class ORDER BY c DESC LIMIT ${Math.max(1, filter.limit ?? 20)}`,
    );
    return rows.map((r) => ({ errorClass: String(r.error_class), count: Number(r.c) }));
  }

  async queryErrorClassDrill(
    filter: ErrorClassFilter & { errorClass: string },
  ): Promise<ErrorClassDrillResult> {
    const where = this.buildChWhere(filter);
    const limit = Math.max(1, filter.limit ?? 100);
    const ec = escapeChString(filter.errorClass);

    // 1. 最近 N 条 traces
    const traceRows = await this.client.query<Record<string, unknown>>(
      `SELECT trace_id, started_at, duration_ms, model, app_id, session_key
       FROM runs ${where} AND error_class = '${ec}'
       ORDER BY started_at DESC LIMIT ${limit}`,
    );
    const recentTraces = traceRows.map((r) => ({
      traceId: String(r.trace_id),
      startedAt: chDateTimeTs(r.started_at),
      durationMs: Number(r.duration_ms),
      model: nonEmpty(r.model),
      appId: nonEmpty(r.app_id),
      sessionKey: nonEmpty(r.session_key),
    }));

    // 2. 模型分布：JOIN spans (kind='model')
    const modelRows = await this.client.query<{ m: string; c: string | number }>(
      `SELECT s.name AS m, count() AS c
       FROM runs r INNER JOIN spans s ON s.trace_id = r.trace_id
       WHERE ${this.chJoinConds(filter)} AND r.error_class = '${ec}' AND s.kind = 'model'
       GROUP BY s.name ORDER BY c DESC`,
    );
    const byModel: Record<string, number> = {};
    for (const r of modelRows) {
      const raw = String(r.m ?? 'unknown');
      const key = raw.startsWith('model:') ? raw.slice('model:'.length) : raw;
      byModel[key] = Number(r.c);
    }

    // 3. 工具分布：JOIN tool_calls（status='error'）
    const toolRows = await this.client.query<{ tn: string; c: string | number }>(
      `SELECT t.tool_name AS tn, count() AS c
       FROM runs r INNER JOIN tool_calls t ON t.trace_id = r.trace_id
       WHERE ${this.chJoinConds(filter)} AND r.error_class = '${ec}' AND t.status = 'error'
       GROUP BY t.tool_name ORDER BY c DESC`,
    );
    const byTool: Record<string, number> = {};
    for (const r of toolRows) {
      byTool[String(r.tn ?? 'unknown')] = Number(r.c);
    }

    return { errorClass: filter.errorClass, recentTraces, byModel, byTool };
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  // ─── 内部辅助 ──────────────────────────────────────────────────
  private buildChWhere(filter: ErrorClassFilter): string {
    const conds: string[] = [];
    if (filter.since !== undefined) conds.push(`started_at >= '${toChDateTime(filter.since)}'`);
    if (filter.until !== undefined) conds.push(`started_at < '${toChDateTime(filter.until)}'`);
    if (filter.appId) conds.push(`app_id = '${escapeChString(filter.appId)}'`);
    return conds.length ? `WHERE ${conds.join(' AND ')}` : 'WHERE 1=1';
  }

  private chJoinConds(filter: ErrorClassFilter): string {
    const conds: string[] = [];
    if (filter.since !== undefined) conds.push(`r.started_at >= '${toChDateTime(filter.since)}'`);
    if (filter.until !== undefined) conds.push(`r.started_at < '${toChDateTime(filter.until)}'`);
    if (filter.appId) conds.push(`r.app_id = '${escapeChString(filter.appId)}'`);
    return conds.length ? conds.join(' AND ') : '1=1';
  }
}

// ─── 行映射：记录 → CH JSONEachRow ────────────────────────────────

function runToRow(r: RunRecord, appId: string | undefined): Record<string, unknown> {
  return {
    trace_id: r.traceId,
    app_id: appId ?? '',
    started_at: toChDateTime(r.startedAt),
    ended_at: toChDateTime(r.endedAt),
    session_key: r.sessionKey ?? '',
    channel: r.channel ?? '',
    model: r.model ?? '',
    version: r.appVersion ?? '',
    status: RUN_STATUS_INDEX[r.status] ?? 2,
    error_class: r.errorClass ?? '',
    turns: r.turns,
    duration_ms: r.durationMs,
    active_ms: r.activeMs,
    queued_ms: r.queuedMs,
    ttft_ms: r.ttftMs ?? 0,
    input_tokens: r.inputTokens ?? 0,
    output_tokens: r.outputTokens ?? 0,
    cache_read: r.cacheRead ?? 0,
    cache_write: r.cacheWrite ?? 0,
    cost_cents: r.costCents ?? 0, // Phase 6：由 worker 端 CostCalculator 计算后写入
  };
}

function spanToRow(s: SpanRecord, appId: string | undefined): Record<string, unknown> {
  return {
    id: 0, // CH 用默认值或由物化视图生成
    trace_id: s.traceId,
    app_id: appId ?? '',
    span_id: s.spanId,
    kind: s.kind === 'model' ? 2 : s.kind === 'tool' ? 3 : 1,
    name: s.name,
    started_at: toChDateTime(s.startedAt),
    duration_ms: s.durationMs,
    status: SPAN_STATUS_INDEX[s.status] ?? 2,
    error_class: s.errorClass ?? '',
    attempts: s.attempts ?? 1,
    input_tokens: s.inputTokens ?? 0,
    output_tokens: s.outputTokens ?? 0,
    cache_read: s.cacheRead ?? 0,
    cache_write: s.cacheWrite ?? 0,
    session_key: s.sessionKey ?? '',
    cost_cents: s.costCents ?? 0, // Phase 6：由 worker 端 CostCalculator 计算后写入
  };
}

function toolToRow(t: ToolCallRecord, appId: string | undefined): Record<string, unknown> {
  // tool_calls 无 started_at 列（init.sql 中由 span 推导），此处用 now() 占位
  return {
    id: 0,
    trace_id: t.traceId,
    app_id: appId ?? '',
    span_id: t.spanId,
    tool_name: t.toolName,
    status: TOOL_STATUS_INDEX[t.status] ?? 2,
    duration_ms: t.durationMs,
    error_class: t.errorClass ?? '',
    started_at: toChDateTime(Date.now()),
  };
}

function eventToRow(e: EventRecord, appId: string | undefined): Record<string, unknown> {
  return {
    id: 0,
    trace_id: e.traceId ?? '',
    app_id: appId ?? '',
    session_key: e.sessionKey ?? '',
    name: e.name,
    data: e.data === undefined ? '' : JSON.stringify(e.data),
    ts: toChDateTime(e.timestamp),
  };
}

function retryToRow(r: RetryRecord, appId: string | undefined): Record<string, unknown> {
  return {
    id: 0,
    trace_id: r.traceId,
    app_id: appId ?? '',
    span_id: r.spanId ?? '',
    provider: r.provider,
    model_id: r.modelId,
    attempt: r.attempt,
    error_class: r.errorClass ?? '',
    status: r.status ?? 0,
    delay_ms: r.delayMs,
    ts: toChDateTime(r.timestamp),
  };
}

// ─── 行映射：CH 行 → 记录 ────────────────────────────────────────

function chRowToRun(r: Record<string, unknown>): RunListItem {
  return {
    traceId: String(r.trace_id),
    appId: optStr(r.app_id),
    startedAt: Number(r.started_at),
    endedAt: Number(r.ended_at),
    sessionKey: String(r.session_key),
    channel: optStr(r.channel),
    model: optStr(r.model),
    appVersion: optStr(r.version),
    status: chRunStatus(Number(r.status)),
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

function chRowToSpan(r: Record<string, unknown>): SpanRecord {
  return {
    traceId: String(r.trace_id),
    spanId: String(r.span_id),
    kind: chSpanKind(Number(r.kind)),
    name: String(r.name),
    startedAt: Number(r.started_at),
    durationMs: Number(r.duration_ms),
    status: chSpanStatus(Number(r.status)),
    errorClass: optStr(r.error_class),
    attempts: optNum(r.attempts),
    inputTokens: optNum(r.input_tokens),
    outputTokens: optNum(r.output_tokens),
    cacheRead: optNum(r.cache_read),
    cacheWrite: optNum(r.cache_write),
    sessionKey: optStr(r.session_key),
  };
}

function chRowToTool(r: Record<string, unknown>): ToolCallRecord {
  return {
    traceId: String(r.trace_id),
    spanId: String(r.span_id),
    toolName: String(r.tool_name),
    status: chToolStatus(Number(r.status)),
    durationMs: Number(r.duration_ms),
    errorClass: optStr(r.error_class),
  };
}

function chRowToEvent(r: Record<string, unknown>): EventRecord {
  return {
    traceId: optStr(r.trace_id),
    sessionKey: optStr(r.session_key),
    name: String(r.name),
    data: r.data === null || r.data === undefined || r.data === '' ? undefined : safeParseJson(String(r.data)),
    timestamp: Number(r.ts),
  };
}

function chRowToRetry(r: Record<string, unknown>): RetryRecord {
  return {
    traceId: String(r.trace_id),
    spanId: optStr(r.span_id),
    provider: String(r.provider),
    modelId: String(r.model_id),
    attempt: Number(r.attempt),
    errorClass: optStr(r.error_class),
    status: optNum(r.status),
    delayMs: Number(r.delay_ms),
    timestamp: Number(r.ts),
  };
}

// ─── CH Enum 索引 → 字符串 ───────────────────────────────────────

function chRunStatus(idx: number): RunRecord['status'] {
  switch (idx) {
    case 1: return 'success';
    case 3: return 'validation';
    default: return 'error';
  }
}

function chSpanKind(idx: number): SpanRecord['kind'] {
  switch (idx) {
    case 2: return 'model';
    case 3: return 'tool';
    default: return 'run';
  }
}

function chSpanStatus(idx: number): SpanRecord['status'] {
  return idx === 1 ? 'ok' : 'error';
}

function chToolStatus(idx: number): ToolCallRecord['status'] {
  switch (idx) {
    case 1: return 'ok';
    case 3: return 'blocked';
    case 4: return 'skipped';
    default: return 'error';
  }
}

// ─── SQL 构造 ─────────────────────────────────────────────────────

function buildRunWhere(filter: RunQueryFilter): string {
  const conds: string[] = [];
  if (filter.since !== undefined) conds.push(`r.started_at >= toDateTime64(${Number(filter.since) / 1000}, 3)`);
  if (filter.until !== undefined) conds.push(`r.started_at < toDateTime64(${Number(filter.until) / 1000}, 3)`);
  if (filter.status) conds.push(`r.status = ${RUN_STATUS_INDEX[filter.status] ?? 2}`);
  if (filter.model) conds.push(`r.model = ${chStr(filter.model)}`);
  if (filter.sessionKey) conds.push(`r.session_key = ${chStr(filter.sessionKey)}`);
  if (filter.appId) conds.push(`r.app_id = ${chStr(filter.appId)}`);
  if (filter.tool) conds.push(`r.trace_id IN (SELECT trace_id FROM tool_calls WHERE tool_name = ${chStr(filter.tool)})`);
  if (filter.version) conds.push(`ifNull(r.version, 'unknown') = ${chStr(filter.version)}`);
  return conds.length ? `WHERE ${conds.join(' AND ')}` : '';
}

/** @deprecated 参数化查询未使用（CH HTTP 走 SQL 字符串插值，已转义） */
function buildRunParams(_filter: RunQueryFilter): unknown[] {
  return [];
}

function buildVersionWhere(filter: { since?: number; until?: number; appId?: string }): string {
  const conds: string[] = [];
  if (filter.since !== undefined) conds.push(`r.started_at >= toDateTime64(${Number(filter.since) / 1000}, 3)`);
  if (filter.until !== undefined) conds.push(`r.started_at < toDateTime64(${Number(filter.until) / 1000}, 3)`);
  if (filter.appId) conds.push(`r.app_id = ${chStr(filter.appId)}`);
  return conds.length ? `WHERE ${conds.join(' AND ')}` : '';
}

/** CH 字符串字面量转义（单引号包裹，内部单引号转义为 \'） */
function chStr(s: string): string {
  return `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

// ─── 辅助 ─────────────────────────────────────────────────────────

function optStr(v: unknown): string | undefined {
  return v === null || v === undefined || v === '' ? undefined : String(v);
}

function optNum(v: unknown): number | undefined {
  return v === null || v === undefined ? undefined : Number(v);
}

function safeParseJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}

function round8(n: number): number {
  return Math.round(n * 1e8) / 1e8;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ─── Phase 9 辅助 ────────────────────────────────────────────────
function escapeChString(s: string): string {
  return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** CH DateTime64(3) → epoch ms；兼容已经是数字的情况 */
function chDateTimeTs(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    // CH 返回格式："2025-01-01 12:00:00.000" 或秒数字符串
    if (/^\d+$/.test(v)) return Number(v);
    if (/^\d+\.\d+$/.test(v)) return Number(v);
    const t = Date.parse(v.replace(' ', 'T'));
    return Number.isFinite(t) ? t : 0;
  }
  return 0;
}

function nonEmpty(v: unknown): string | undefined {
  return v === null || v === undefined || v === '' ? undefined : String(v);
}
