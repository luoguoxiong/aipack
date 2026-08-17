/**
 * REST API（observability-s2.md §6/§7）：原生 node:http，可挂载到任意现有 server。
 *
 *   GET /metrics/summary?appId&since&until&version&groupBy=model|tool|session
 *   GET /metrics/timeseries?appId&since&until&version&step&metric=requests|successRate|tokensTotal|cost
 *   GET /metrics/tools?appId&since&until&version
 *   GET /metrics/versions?appId&since&until
 *   GET /metrics/cost?appId&since&until&groupBy=model|app            — Phase 6 成本汇总
 *   GET /metrics/model-prices                                        — Phase 6 模型价格列表
 *   POST /metrics/model-prices                                       — Phase 6 新增/更新模型价格
 *   DELETE /metrics/model-prices/:modelId?effectiveAt=               — Phase 6 删除模型价格
 *   GET /traces?appId&since&until&status&model&tool&sessionKey&version&page&pageSize
 *   GET /traces/:traceId
 *   Phase 9 新增：
 *     GET /metrics/error-classes?appId&since&until          — 错误类 TopN 计数（面板卡片）
 *     GET /metrics/error-classes/:cls?appId&since&until     — 错误归因下钻：最近 N traces + 工具/模型分布
 *
 * appId 缺省 = 全局聚合（所有应用合并）；指定则只看该应用。鉴权由挂载方（collector）负责。
 */

import http from 'node:http';
import type { Aggregator } from './aggregator/interface';
import type { TraceStore } from './store';
import type { ModelPriceStore } from './stores/model-price-store';
import type {
  GroupBy,
  SummaryFilter,
  TimeseriesMetric,
} from './types';

export interface ApiDeps {
  /** 按应用解析聚合器；不传 appId 返回全局（合并所有应用） */
  aggregatorFor(appId?: string): Aggregator;
  store: TraceStore;
  /** Phase 6 — 模型价格管理（可选，未注入时 model-prices 端点返回 501） */
  modelPriceStore?: ModelPriceStore;
}

export type ApiHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
) => Promise<void>;

export function createApiHandler(deps: ApiDeps): ApiHandler {
  return async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      const path = url.pathname;
      const appId = url.searchParams.get('appId') || undefined;
      const method = req.method || 'GET';

      // ─── GET 端点 ───────────────────────────────────────────────
      if (method === 'GET') {
        if (path === '/metrics/summary') return metricsSummary(url, deps, res, appId);
        if (path === '/metrics/timeseries') return metricsTimeseries(url, deps, res, appId);
        if (path === '/metrics/tools') return metricsTools(url, deps, res, appId);
        if (path === '/metrics/versions') return metricsVersions(url, deps, res, appId);
        // Phase 6 — 成本汇总
        if (path === '/metrics/cost') return metricsCost(url, deps, res, appId);
        // Phase 6 — 模型价格列表
        if (path === '/metrics/model-prices') return modelPricesList(deps, res);
        // Phase 9 — 错误归因下钻
        if (path === '/metrics/error-classes') return errorClassesList(url, deps, res, appId);
        const errorDrillMatch = path.match(/^\/metrics\/error-classes\/(.+)$/);
        if (errorDrillMatch) return errorClassDrill(decodeURIComponent(errorDrillMatch[1]), url, deps, res, appId);
        if (path === '/traces') return tracesList(url, deps, res, appId);

        const traceMatch = path.match(/^\/traces\/(.+)$/);
        if (traceMatch) return traceDetail(decodeURIComponent(traceMatch[1]), deps, res);
      }

      // ─── POST 端点 ──────────────────────────────────────────────
      if (method === 'POST') {
        if (path === '/metrics/model-prices') return modelPriceCreate(req, deps, res);
      }

      // ─── DELETE 端点 ────────────────────────────────────────────
      if (method === 'DELETE') {
        const priceDelMatch = path.match(/^\/metrics\/model-prices\/(.+)$/);
        if (priceDelMatch) return modelPriceDelete(decodeURIComponent(priceDelMatch[1]), url, deps, res);
      }

      return json(res, 404, { error: 'Not Found' });
    } catch (err) {
      return json(res, 500, { error: err instanceof Error ? err.message : 'Internal Error' });
    }
  };
}

// ─── 端点实现 ─────────────────────────────────────────────────────

async function metricsSummary(
  url: URL,
  { aggregatorFor }: ApiDeps,
  res: http.ServerResponse,
  appId?: string,
): Promise<void> {
  const filter = parseFilter(url);
  const groupBy = url.searchParams.get('groupBy') as GroupBy | null;
  const body = await aggregatorFor(appId).summary(filter, groupBy ?? undefined);
  return json(res, 200, body);
}

async function metricsTimeseries(
  url: URL,
  { aggregatorFor }: ApiDeps,
  res: http.ServerResponse,
  appId?: string,
): Promise<void> {
  const filter = parseFilter(url);
  const stepMs = intParam(url, 'step', 5 * 60 * 1000, 60 * 1000);
  const metric = (url.searchParams.get('metric') as TimeseriesMetric) || 'requests';
  if (!['requests', 'successRate', 'tokensTotal', 'cost'].includes(metric)) {
    return json(res, 400, { error: 'metric 仅支持 requests|successRate|tokensTotal|cost' });
  }
  return json(res, 200, await aggregatorFor(appId).timeseries(filter, stepMs, metric));
}

async function metricsTools(
  url: URL,
  { aggregatorFor }: ApiDeps,
  res: http.ServerResponse,
  appId?: string,
): Promise<void> {
  return json(res, 200, await aggregatorFor(appId).tools(parseFilter(url)));
}

/** 版本聚合：DB 直查（非内存窗口），供跨版本指标对比 */
async function metricsVersions(
  url: URL,
  { store }: ApiDeps,
  res: http.ServerResponse,
  appId?: string,
): Promise<void> {
  const filter = parseFilter(url);
  const items = await store.queryVersionMetrics({
    since: filter.since,
    until: filter.until,
    appId,
  });
  return json(res, 200, { items });
}

async function tracesList(
  url: URL,
  { store }: ApiDeps,
  res: http.ServerResponse,
  appId?: string,
): Promise<void> {
  const filter = parseFilter(url);
  const page = Math.max(1, intParam(url, 'page', 1, 1));
  const pageSize = Math.min(100, Math.max(1, intParam(url, 'pageSize', 20, 1)));
  const result = await store.queryRuns({
    since: filter.since,
    until: filter.until,
    status: url.searchParams.get('status') || undefined,
    model: url.searchParams.get('model') || undefined,
    tool: url.searchParams.get('tool') || undefined,
    sessionKey: url.searchParams.get('sessionKey') || undefined,
    version: filter.version,
    appId,
    offset: (page - 1) * pageSize,
    limit: pageSize,
  });
  return json(res, 200, {
    page,
    pageSize,
    total: result.total,
    items: result.items.map((r) => ({
      traceId: r.traceId,
      appId: r.appId,
      appVersion: r.appVersion,
      startedAt: r.startedAt,
      durationMs: r.durationMs,
      status: r.status,
      errorClass: r.errorClass,
      turns: r.turns,
      tokens: { input: r.inputTokens, output: r.outputTokens, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite },
      retries: r.retries,
      sessionKey: r.sessionKey,
      // Phase 9 — W3C Trace Context
      parentTraceId: r.parentTraceId,
      w3cTraceId: r.w3cTraceId,
    })),
  });
}

async function traceDetail(
  traceId: string,
  { store }: ApiDeps,
  res: http.ServerResponse,
): Promise<void> {
  const detail = await store.queryTrace(traceId);
  if (!detail) return json(res, 404, { error: 'trace not found' });
  return json(res, 200, {
    traceId,
    run: {
      status: detail.run.status,
      errorClass: detail.run.errorClass,
      durationMs: detail.run.durationMs,
      turns: detail.run.turns,
      tokens: {
        input: detail.run.inputTokens,
        output: detail.run.outputTokens,
        cacheRead: detail.run.cacheRead ?? 0,
        cacheWrite: detail.run.cacheWrite ?? 0,
      },
      // Phase 9 — W3C Trace Context：父链路跳转
      parentTraceId: detail.run.parentTraceId,
      w3cTraceId: detail.run.w3cTraceId,
    },
    spans: detail.spans.map((s) => ({
      kind: s.kind,
      name: s.name,
      startedAt: s.startedAt,
      durationMs: s.durationMs,
      status: s.status,
      errorClass: s.errorClass,
      attempts: s.attempts,
      tokens: { input: s.inputTokens ?? 0, output: s.outputTokens ?? 0, cacheRead: s.cacheRead ?? 0, cacheWrite: s.cacheWrite ?? 0 },
    })),
    // P2-1 自定义事件（时间轴）
    events: detail.events.map((e) => ({
      name: e.name,
      data: e.data,
      timestamp: e.timestamp,
      sessionKey: e.sessionKey,
    })),
    // P2-2 per-attempt 重试链
    retries: detail.retries.map((r) => ({
      provider: r.provider,
      modelId: r.modelId,
      attempt: r.attempt,
      errorClass: r.errorClass,
      status: r.status,
      delayMs: r.delayMs,
      timestamp: r.timestamp,
    })),
  });
}

// ─── Phase 9：错误归因下钻 ─────────────────────────────────────────

/** 错误类 TopN：面板 ErrorClass 卡片点击 → 跳转下钻页 */
async function errorClassesList(
  url: URL,
  { store }: ApiDeps,
  res: http.ServerResponse,
  appId?: string,
): Promise<void> {
  const filter = parseFilter(url);
  const limit = Math.min(50, intParam(url, 'limit', 20, 1));
  const data = await store.queryErrorClassCounts({
    since: filter.since,
    until: filter.until,
    appId,
    limit,
  });
  return json(res, 200, { items: data });
}

/** 单错误类下钻：最近 100 条 trace + 工具/模型分布 */
async function errorClassDrill(
  errorClass: string,
  url: URL,
  { store }: ApiDeps,
  res: http.ServerResponse,
  appId?: string,
): Promise<void> {
  const filter = parseFilter(url);
  const limit = Math.min(200, intParam(url, 'limit', 100, 1));
  const data = await store.queryErrorClassDrill({
    errorClass,
    since: filter.since,
    until: filter.until,
    appId,
    limit,
  });
  return json(res, 200, data);
}

// ─── Phase 6：成本核算 ───────────────────────────────────────────

/** 成本汇总：按 groupBy 维度（model/app）返回各分组的总成本（分）+ 请求数 */
async function metricsCost(
  url: URL,
  deps: ApiDeps,
  res: http.ServerResponse,
  appId?: string,
): Promise<void> {
  const filter = parseFilter(url);
  const groupBy = url.searchParams.get('groupBy') || 'model';
  if (groupBy === 'model') {
    // 按 model 维度 summary → Record<modelId, AggregatedMetrics>
    const body = await deps.aggregatorFor(appId).summary(filter, 'model');
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      const items = Object.entries(body).map(([key, m]) => ({
        key,
        costCents: (m as { costTotal?: number }).costTotal ?? 0,
        runs: (m as { requests?: number }).requests ?? 0,
      }));
      return json(res, 200, items);
    }
    return json(res, 200, []);
  }
  // groupBy=app：全局 summary 的 costTotal
  const body = await deps.aggregatorFor(appId).summary(filter);
  const summary = body as { costTotal?: number; requests?: number };
  return json(res, 200, [{ key: appId ?? 'global', costCents: summary.costTotal ?? 0, runs: summary.requests ?? 0 }]);
}

/** 模型价格列表 */
async function modelPricesList(deps: ApiDeps, res: http.ServerResponse): Promise<void> {
  if (!deps.modelPriceStore) return json(res, 501, { error: 'modelPriceStore 未注入' });
  const items = await deps.modelPriceStore.list();
  return json(res, 200, items);
}

/** 新增/更新模型价格 */
async function modelPriceCreate(
  req: http.IncomingMessage,
  deps: ApiDeps,
  res: http.ServerResponse,
): Promise<void> {
  if (!deps.modelPriceStore) return json(res, 501, { error: 'modelPriceStore 未注入' });
  const body = await readBody(req);
  const input = JSON.parse(body) as {
    modelId: string;
    inputPer1m: number;
    outputPer1m: number;
    cacheReadPer1m?: number;
    cacheWritePer1m?: number;
    currency?: string;
    effectiveAt?: number;
  };
  if (!input.modelId || typeof input.inputPer1m !== 'number' || typeof input.outputPer1m !== 'number') {
    return json(res, 400, { error: '缺少必填字段：modelId, inputPer1m, outputPer1m' });
  }
  const item = await deps.modelPriceStore.upsert({
    modelId: input.modelId,
    inputPer1m: input.inputPer1m,
    outputPer1m: input.outputPer1m,
    cacheReadPer1m: input.cacheReadPer1m ?? 0,
    cacheWritePer1m: input.cacheWritePer1m ?? 0,
    currency: input.currency ?? 'USD',
    effectiveAt: input.effectiveAt ?? Date.now(),
  });
  return json(res, 201, item);
}

/** 删除模型价格 */
async function modelPriceDelete(
  modelId: string,
  url: URL,
  deps: ApiDeps,
  res: http.ServerResponse,
): Promise<void> {
  if (!deps.modelPriceStore) return json(res, 501, { error: 'modelPriceStore 未注入' });
  const effectiveAtStr = url.searchParams.get('effectiveAt');
  if (!effectiveAtStr) return json(res, 400, { error: '缺少 effectiveAt 参数' });
  const effectiveAt = Number(effectiveAtStr);
  if (!Number.isFinite(effectiveAt)) return json(res, 400, { error: 'effectiveAt 不是有效数字' });
  const ok = await deps.modelPriceStore.delete(modelId, effectiveAt);
  return json(res, ok ? 200 : 404, ok ? { ok: true } : { error: '未找到对应价格记录' });
}

// ─── 辅助 ─────────────────────────────────────────────────────────

function parseFilter(url: URL): SummaryFilter {
  const since = url.searchParams.get('since');
  const until = url.searchParams.get('until');
  return {
    since: since !== null && since !== '' ? Number(since) : undefined,
    until: until !== null && until !== '' ? Number(until) : undefined,
    version: url.searchParams.get('version') || undefined,
  };
}

function intParam(url: URL, name: string, def: number, min: number): number {
  const raw = url.searchParams.get(name);
  const v = raw === null ? def : Number(raw);
  return Number.isFinite(v) ? Math.max(min, v) : def;
}

function json(
  res: http.ServerResponse,
  status: number,
  body: unknown,
): Promise<void> {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  return new Promise((resolve) => {
    res.end(JSON.stringify(body), () => resolve());
  });
}

/** 读取请求 body（上限 1MB） */
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(new Error('body 超过 1MB 上限'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}
