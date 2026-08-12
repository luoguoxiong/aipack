/**
 * REST API（observability-s2.md §6/§7）：原生 node:http，可挂载到任意现有 server。
 *
 *   GET /metrics/summary?appId&since&until&groupBy=model|tool|session
 *   GET /metrics/timeseries?appId&since&until&step&metric=requests|successRate|costUsd
 *   GET /metrics/tools?appId&since&until
 *   GET /traces?appId&since&until&status&model&tool&sessionKey&page&pageSize
 *   GET /traces/:traceId
 *
 * appId 缺省 = 全局聚合（所有应用合并）；指定则只看该应用。鉴权由挂载方（collector）负责。
 */

import http from 'node:http';
import type { Aggregator } from './aggregator';
import type { TraceStore } from './store';
import type {
  GroupBy,
  SummaryFilter,
  TimeseriesMetric,
} from './types';

export interface ApiDeps {
  /** 按应用解析聚合器；不传 appId 返回全局（合并所有应用） */
  aggregatorFor(appId?: string): Aggregator;
  store: TraceStore;
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

      if (req.method !== 'GET') {
        return json(res, 405, { error: 'Method Not Allowed' });
      }

      if (path === '/metrics/summary') return metricsSummary(url, deps, res, appId);
      if (path === '/metrics/timeseries') return metricsTimeseries(url, deps, res, appId);
      if (path === '/metrics/tools') return metricsTools(url, deps, res, appId);
      if (path === '/traces') return tracesList(url, deps, res, appId);

      const traceMatch = path.match(/^\/traces\/(.+)$/);
      if (traceMatch) return traceDetail(decodeURIComponent(traceMatch[1]), deps, res);

      return json(res, 404, { error: 'Not Found' });
    } catch (err) {
      return json(res, 500, { error: err instanceof Error ? err.message : 'Internal Error' });
    }
  };
}

// ─── 端点实现 ─────────────────────────────────────────────────────

function metricsSummary(
  url: URL,
  { aggregatorFor }: ApiDeps,
  res: http.ServerResponse,
  appId?: string,
): Promise<void> {
  const filter = parseFilter(url);
  const groupBy = url.searchParams.get('groupBy') as GroupBy | null;
  const body = aggregatorFor(appId).summary(filter, groupBy ?? undefined);
  return json(res, 200, body);
}

function metricsTimeseries(
  url: URL,
  { aggregatorFor }: ApiDeps,
  res: http.ServerResponse,
  appId?: string,
): Promise<void> {
  const filter = parseFilter(url);
  const stepMs = intParam(url, 'step', 5 * 60 * 1000, 60 * 1000);
  const metric = (url.searchParams.get('metric') as TimeseriesMetric) || 'requests';
  if (!['requests', 'successRate', 'costUsd'].includes(metric)) {
    return json(res, 400, { error: 'metric 仅支持 requests|successRate|costUsd' });
  }
  return json(res, 200, aggregatorFor(appId).timeseries(filter, stepMs, metric));
}

function metricsTools(
  url: URL,
  { aggregatorFor }: ApiDeps,
  res: http.ServerResponse,
  appId?: string,
): Promise<void> {
  return json(res, 200, aggregatorFor(appId).tools(parseFilter(url)));
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
  const result = store.queryRuns({
    since: filter.since,
    until: filter.until,
    status: url.searchParams.get('status') || undefined,
    model: url.searchParams.get('model') || undefined,
    tool: url.searchParams.get('tool') || undefined,
    sessionKey: url.searchParams.get('sessionKey') || undefined,
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
      startedAt: r.startedAt,
      durationMs: r.durationMs,
      status: r.status,
      turns: r.turns,
      tokens: { input: r.inputTokens, output: r.outputTokens },
      costUsd: r.costUsd,
      retries: r.retries,
      sessionKey: r.sessionKey,
    })),
  });
}

async function traceDetail(
  traceId: string,
  { store }: ApiDeps,
  res: http.ServerResponse,
): Promise<void> {
  const detail = store.queryTrace(traceId);
  if (!detail) return json(res, 404, { error: 'trace not found' });
  return json(res, 200, {
    traceId,
    spans: detail.spans.map((s) => ({
      kind: s.kind,
      name: s.name,
      startedAt: s.startedAt,
      durationMs: s.durationMs,
      status: s.status,
      errorClass: s.errorClass,
      attempts: s.attempts,
      tokens: { input: s.inputTokens ?? 0, output: s.outputTokens ?? 0 },
      costUsd: s.costUsd,
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

// ─── 辅助 ─────────────────────────────────────────────────────────

function parseFilter(url: URL): SummaryFilter {
  const since = url.searchParams.get('since');
  const until = url.searchParams.get('until');
  return {
    since: since !== null && since !== '' ? Number(since) : undefined,
    until: until !== null && until !== '' ? Number(until) : undefined,
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
