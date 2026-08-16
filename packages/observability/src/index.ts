/**
 * @aipack-ai/observability — aipack 可观测性上报 SDK。
 *
 * 埋点上报模式：客户端只需 appId + appSecret，6 类 Telemetry 事件自动批量
 * POST 到收集服务（默认 http://localhost:8787），失败本地缓存补报。
 *
 *   const obs = createObservability({ appId: 'my-app', appSecret: 'xxx' });
 *   createRuntime({ ..., telemetry: obs.telemetry });
 *
 * 收集服务见 @aipack-ai/observability-server（独立包，SQLite 落盘 + 内存聚合 + REST API）。
 */

import { HttpReporter } from './reporter';
import { ObservabilityTelemetry } from './telemetry';
import { createLogger, type Logger } from './logger';
import { createOtlpTraceExporter } from './otlp';

export interface CreateObservabilityOptions {
  /** 应用标识（必填），收集端用它校验身份并隔离数据 */
  appId: string;
  /** 应用密钥（必填），与收集端 OBS_APPS 白名单匹配 */
  appSecret: string;
  /** 收集服务地址，默认 http://localhost:8787 */
  endpoint?: string;
  /** 上报失败本地缓存目录，默认 ./.aipack/observability */
  cacheDir?: string;
  /** 缓存条数上限，默认 2000 */
  maxCacheSize?: number;
  /** 上报周期（ms），默认 5000 */
  flushIntervalMs?: number;
  /** 积攒条数触发上报，默认 50 */
  flushBatchSize?: number;
  /** 可选：OTLP/HTTP JSON trace 导出（推 OpenTelemetry Collector），失败不影响主上报 */
  otlp?: {
    endpoint: string;
    serviceName?: string;
    headers?: Record<string, string>;
  };
  /** P2-1 明细采样率（0–1）：只对 model/tool spans 与 toolCalls 采样，runs/permissions/events 全量。缺省 1 */
  sampleRate?: number;
  /** P2-1 脱敏钩子：send 前对整批改写（防 PII 明文上报），示例见 docs/observability-roadmap.md §P2-1 */
  redact?: (batch: import('./types').EventBatch) => import('./types').EventBatch;
  /** 发布版本（如 '1.3.0'），随每条 run 上报，供收集端按版本聚合对比。缺省不携带 */
  version?: string;
}

export interface Observability {
  /** 注入 RuntimeOptions.telemetry */
  telemetry: ObservabilityTelemetry;
  /** 结构化 logger：自动注入当前 run 的 traceId（P1-1 日志关联） */
  logger: Logger;
  /** P2-1 自定义业务事件：run 内自动带 traceId，入 Trace 时间轴 */
  emit(name: string, data?: unknown, opts?: { traceId?: string; sessionKey?: string }): void;
  /** 立即上报队列中的残留数据 */
  flush(): void;
  /** 停止定时器并等残留上报完成（进程退出前调用） */
  close(): Promise<void>;
}

export function createObservability(opts: CreateObservabilityOptions): Observability {
  const reporter = new HttpReporter({
    endpoint: opts.endpoint ?? 'http://localhost:8787',
    appId: opts.appId,
    appSecret: opts.appSecret,
    cacheDir: opts.cacheDir,
    maxCacheSize: opts.maxCacheSize,
  });

  // OTLP 导出作为旁路：await 但不影响主上报结果；exporter 内部恒不抛错
  const sink: { send(batch: import('./types').EventBatch): Promise<boolean> } = reporter;
  if (opts.otlp) {
    const exporter = createOtlpTraceExporter({
      endpoint: opts.otlp.endpoint,
      serviceName: opts.otlp.serviceName ?? opts.appId,
      appId: opts.appId,
      headers: opts.otlp.headers,
    });
    sink.send = async (batch) => {
      const ok = await reporter.send(batch);
      await exporter.export(batch);
      return ok;
    };
  }

  const telemetry = new ObservabilityTelemetry(sink, {
    intervalMs: opts.flushIntervalMs,
    batchSize: opts.flushBatchSize,
    sampleRate: opts.sampleRate,
    redact: opts.redact,
    appVersion: opts.version,
  });
  const logger = createLogger({
    tags: { app: opts.appId },
    context: () => telemetry.currentContext(),
  });

  return {
    telemetry,
    logger,
    emit: (name, data, emitOpts) => telemetry.emit(name, data, emitOpts),
    flush: () => telemetry.flush(),
    close: async () => {
      await telemetry.close();
    },
  };
}

// ─── 类型导出 ─────────────────────────────────────────────────────

export { ObservabilityTelemetry } from './telemetry';
export type { FlushQueueOptions } from './telemetry';
export { HttpReporter } from './reporter';
export type { ReporterOptions } from './reporter';
export { createLogger } from './logger';
export type { Logger, LoggerOptions, LogLevel, LogFormat } from './logger';
export { createOtlpTraceExporter, toOtlpJsonTraces } from './otlp';
export type { OtlpTraceExporter, OtlpExporterOptions } from './otlp';
export type {
  RunRecord,
  SpanRecord,
  ToolCallRecord,
  PermissionRecord,
  EventRecord,
  RetryRecord,
  EventBatch,
} from './types';
