/**
 * Prometheus 文本格式导出（P1-2 标准协议，档位 B 起步）。
 *
 * GET /metrics/prometheus → text/plain; version=0.0.4
 * 数据源：内存聚合器当前滑动窗口（windowMs），与面板 /metrics/summary 同源。
 * 语义：counter 类按"窗口计数"近似导出（重启/窗口滑动会跳变，文档说明；
 *        严格 counter 需 OTLP/推送型，留待 P3）。gauge 类直接导出当前值。
 */

import type { Aggregator } from './aggregator';
import type { AggregatedMetrics } from './types';

export interface PrometheusDeps {
  aggregatorFor(appId?: string): Aggregator;
  /** 已知应用 id（种子 + 面板动态创建），用于按应用拆分导出 */
  appIds(): string[];
  /** 聚合窗口（ms），默认 60min */
  windowMs?: number;
}

const DEFAULT_WINDOW_MS = 60 * 60 * 1000;

/** Prometheus 浮点渲染：整数原样，否则最多 6 位小数（去尾零） */
function fmt(v: number): string {
  if (!Number.isFinite(v)) return '0';
  if (Number.isInteger(v)) return String(v);
  const s = v.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  return s || '0';
}

function label(appId?: string): string {
  return appId ? `{app_id="${appId}"}` : '';
}

function metric(
  help: string,
  type: string,
  lines: string[],
  out: string[],
): void {
  const name = lines.length ? /^(\w+)/.exec(lines[0])?.[1] : undefined;
  if (!name) return;
  out.push(`# HELP ${name} ${help}`);
  out.push(`# TYPE ${name} ${type}`);
  out.push(...lines);
}

/** 渲染 Prometheus 文本（每次调用快照当前聚合窗口） */
export function renderPrometheusMetrics(deps: PrometheusDeps): string {
  const windowMs = deps.windowMs ?? DEFAULT_WINDOW_MS;
  const since = Date.now() - windowMs;
  const out: string[] = [];
  const requests: string[] = [];
  const successRatio: string[] = [];
  const retryRate: string[] = [];
  const avgTurns: string[] = [];
  const p50: string[] = [];
  const p95: string[] = [];
  const p99: string[] = [];
  const cost: string[] = [];
  const permissionDenied: string[] = [];
  const errors: string[] = [];
  const toolCalls: string[] = [];
  const toolSuccessRatio: string[] = [];

  // 全局（空 app_id）+ 各应用
  const appIds = ['', ...deps.appIds()];
  for (const appId of appIds) {
    const agg = deps.aggregatorFor(appId || undefined);
    // summary 签名带 groupBy 重载返回联合类型，此处不分组 → 显式窄化为单应用聚合
    const s = agg.summary({ since }) as AggregatedMetrics;
    const lbl = label(appId || undefined);
    requests.push(`aipack_requests_total${lbl} ${fmt(s.requests)}`);
    successRatio.push(`aipack_success_ratio${lbl} ${fmt(s.successRate)}`);
    retryRate.push(`aipack_retry_rate${lbl} ${fmt(s.retryRate)}`);
    avgTurns.push(`aipack_avg_turns${lbl} ${fmt(s.avgTurns)}`);
    p50.push(`aipack_p50_ms${lbl} ${fmt(s.p50Ms)}`);
    p95.push(`aipack_p95_ms${lbl} ${fmt(s.p95Ms)}`);
    p99.push(`aipack_p99_ms${lbl} ${fmt(s.p99Ms)}`);
    cost.push(`aipack_cost_usd_total${lbl} ${fmt(s.costUsd)}`);
    permissionDenied.push(`aipack_permission_denied_total${lbl} ${fmt(s.permissionDenied)}`);
    for (const [cls, count] of Object.entries(s.errorClasses)) {
      errors.push(
        `aipack_errors_total${appId ? `{app_id="${appId}",class="${escapeLabel(cls)}"}` : `{class="${escapeLabel(cls)}"}`} ${count}`,
      );
    }
    for (const t of agg.tools({ since })) {
      const toolLbl = appId ? `{app_id="${appId}",tool="${escapeLabel(t.tool)}"}` : `{tool="${escapeLabel(t.tool)}"}`;
      toolCalls.push(`aipack_tool_calls_total${toolLbl} ${t.calls}`);
      toolSuccessRatio.push(`aipack_tool_success_ratio${toolLbl} ${fmt(t.successRate)}`);
    }
  }

  metric('累计请求数（当前聚合窗口）', 'counter', requests, out);
  metric('成功率（0~1，窗口均值）', 'gauge', successRatio, out);
  metric('重试率（窗口均值）', 'gauge', retryRate, out);
  metric('平均步数（窗口均值）', 'gauge', avgTurns, out);
  metric('P50 耗时 ms（窗口在线分位数）', 'gauge', p50, out);
  metric('P95 耗时 ms（窗口在线分位数）', 'gauge', p95, out);
  metric('P99 耗时 ms（窗口在线分位数）', 'gauge', p99, out);
  metric('累计成本 USD（窗口）', 'gauge', cost, out);
  metric('权限拦截计数（窗口）', 'counter', permissionDenied, out);
  metric('错误计数（窗口，按 errorClass）', 'counter', errors, out);
  metric('工具调用计数（窗口）', 'counter', toolCalls, out);
  metric('工具成功率（窗口均值）', 'gauge', toolSuccessRatio, out);

  return out.join('\n') + '\n';
}

function escapeLabel(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}
