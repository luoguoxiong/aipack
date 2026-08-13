/**
 * OTLP/HTTP JSON trace exporter（P1-2 标准协议，档位 B 起步）。
 *
 * 无外部依赖：直接把 EventBatch 映射为 OTLP JSON ExportTraceServiceRequest
 * （protobuf JSON 编码），POST 到 OpenTelemetry Collector 的 /v1/traces。
 *
 * - traceId/spanId：OTLP 要求 16/8 字节二进制（base64），本 SDK 的 traceId 是任意
 *   字符串，故用 md5 做确定性映射（同一字符串恒得同一字节序列）；
 * - 导出为 best-effort：失败仅 warn，不影响主上报链路（主链路仍走 HttpReporter）；
 * - 未配置 otlp 时零开销（不构造 exporter）。
 */

import { createHash } from 'node:crypto';
import type { EventBatch, RunRecord, SpanRecord } from './types';

export interface OtlpExporterOptions {
  /** OTLP/HTTP JSON 端点，如 http://otel-collector:4318（POST {endpoint}/v1/traces） */
  endpoint: string;
  /** resource.service.name，默认 = appId */
  serviceName?: string;
  /** 应用标识（写入 span attribute aipack.app，便于按应用过滤） */
  appId?: string;
  /** 额外请求头（如 x-otlp-token） */
  headers?: Record<string, string>;
  /** 超时（ms），默认 3000 */
  timeoutMs?: number;
  /** 便于测试注入；默认全局 fetch */
  fetchImpl?: typeof fetch;
}

export interface OtlpTraceExporter {
  /** 导出批次；失败内部消化，恒不抛错，返回是否成功 */
  export(batch: EventBatch): Promise<boolean>;
}

/** md5 确定性映射为 N 字节（traceId=16B / spanId=8B） */
function bytesOf(input: string, n: number): Buffer {
  return createHash('md5').update(input).digest().subarray(0, n);
}

function str(value: unknown): { stringValue: string } {
  return { stringValue: value == null ? '' : String(value) };
}
function int64(value: number): { intValue: string } {
  return { intValue: String(Math.round(value || 0)) };
}

function attr(key: string, value: { stringValue?: string; intValue?: string }): object {
  return { key, value };
}

/** token 总消耗（input + output + cacheRead + cacheWrite）；无 token 数据时返回 undefined */
function tokenTotal(r: { inputTokens?: number; outputTokens?: number; cacheRead?: number; cacheWrite?: number }): number | undefined {
  if (r.inputTokens === undefined && r.outputTokens === undefined) return undefined;
  return (r.inputTokens ?? 0) + (r.outputTokens ?? 0) + (r.cacheRead ?? 0) + (r.cacheWrite ?? 0);
}

/** RunRecord → OTLP span（根 span，kind=INTERNAL） */
function runToSpan(r: RunRecord, appId?: string): object {
  const startNs = BigInt(r.startedAt) * 1_000_000n;
  const endNs = BigInt(r.startedAt + r.durationMs) * 1_000_000n;
  const ok = r.status === 'success';
  const attrs: object[] = [
    attr('session.key', str(r.sessionKey)),
    attr('aipack.status', str(r.status)),
    attr('aipack.turns', int64(r.turns)),
    attr('aipack.duration_ms', int64(r.durationMs)),
    attr('tokens.input', int64(r.inputTokens)),
    attr('tokens.output', int64(r.outputTokens)),
  ];
  if (tokenTotal(r) !== undefined) attrs.push(attr('tokens.total', int64(tokenTotal(r)!)));
  if (appId) attrs.push(attr('aipack.app', str(appId)));
  if (r.model) attrs.push(attr('model', str(r.model)));
  if (r.errorClass) attrs.push(attr('aipack.error_class', str(r.errorClass)));
  return {
    traceId: bytesOf(r.traceId, 16).toString('base64'),
    spanId: bytesOf(`${r.traceId}:run`, 8).toString('base64'),
    name: 'agent.run',
    kind: 1, // INTERNAL
    startTimeUnixNano: startNs.toString(),
    endTimeUnixNano: endNs.toString(),
    attributes: attrs,
    status: ok ? { code: 1 } : { code: 2, message: r.errorClass || r.status },
  };
}

/** SpanRecord → OTLP span */
function spanToSpan(s: SpanRecord, appId?: string): object {
  const startNs = BigInt(s.startedAt) * 1_000_000n;
  const endNs = BigInt(s.startedAt + s.durationMs) * 1_000_000n;
  const ok = s.status === 'ok';
  const attrs: object[] = [
    attr('span.kind', str(s.kind)),
    attr('session.key', str(s.sessionKey)),
    attr('aipack.status', str(s.status)),
    attr('aipack.duration_ms', int64(s.durationMs)),
  ];
  if (appId) attrs.push(attr('aipack.app', str(appId)));
  if (s.inputTokens !== undefined) attrs.push(attr('tokens.input', int64(s.inputTokens)));
  if (s.outputTokens !== undefined) attrs.push(attr('tokens.output', int64(s.outputTokens)));
  if (tokenTotal(s) !== undefined) attrs.push(attr('tokens.total', int64(tokenTotal(s)!)));
  if (s.attempts !== undefined) attrs.push(attr('aipack.attempts', int64(s.attempts)));
  if (s.errorClass) attrs.push(attr('aipack.error_class', str(s.errorClass)));
  return {
    traceId: bytesOf(s.traceId, 16).toString('base64'),
    spanId: bytesOf(s.spanId, 8).toString('base64'),
    name: s.name,
    kind: 1, // INTERNAL
    startTimeUnixNano: startNs.toString(),
    endTimeUnixNano: endNs.toString(),
    attributes: attrs,
    status: ok ? { code: 1 } : { code: 2, message: s.errorClass || s.status },
  };
}

/** EventBatch → OTLP ExportTraceServiceRequest（JSON 对象，可直接 JSON.stringify） */
export function toOtlpJsonTraces(batch: EventBatch, serviceName: string, appId?: string): object {
  const spans: object[] = [];
  for (const r of batch.runs) spans.push(runToSpan(r, appId));
  for (const s of batch.spans) spans.push(spanToSpan(s, appId));
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: 'service.name', value: str(serviceName) },
            { key: 'telemetry.sdk.name', value: str('aipack') },
            { key: 'telemetry.sdk.language', value: str('nodejs') },
          ],
        },
        scopeSpans: [
          {
            scope: { name: 'aipack', version: '0.1.0' },
            spans,
          },
        ],
      },
    ],
  };
}

export function createOtlpTraceExporter(opts: OtlpExporterOptions): OtlpTraceExporter {
  const endpoint = opts.endpoint.replace(/\/+$/, '');
  const serviceName = opts.serviceName ?? 'aipack-app';
  const timeoutMs = opts.timeoutMs ?? 3000;
  const headers = { 'content-type': 'application/json', ...opts.headers };
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;

  return {
    async export(batch) {
      const runs = batch.runs.length;
      const spans = batch.spans.length;
      if (!runs && !spans) return true; // 无 trace 数据（纯 tool/permission）→ 无操作
      try {
        const body = JSON.stringify(toOtlpJsonTraces(batch, serviceName, opts.appId));
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), timeoutMs);
        let res: Response;
        try {
          res = await fetchImpl(`${endpoint}/v1/traces`, {
            method: 'POST',
            headers,
            body,
            signal: ac.signal,
          });
        } finally {
          clearTimeout(timer);
        }
        if (res.ok) return true;
        console.warn(`[aipack/observability] OTLP 导出被拒绝(${res.status})，已跳过（不影响主上报）`);
        return false;
      } catch (err) {
        console.warn('[aipack/observability] OTLP 导出失败（不影响主上报）:', (err as Error).message);
        return false;
      }
    },
  };
}
