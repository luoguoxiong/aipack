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
 *
 * Phase 9 新增：
 *  - sampleStrategy：error-priority / slow-priority / traceid-ratio（替代简单 sampleRate）
 *  - W3C Trace Context：traceparent 输入/输出（跨系统调用链打通）
 *  - 内置 PII 脱敏：默认启用，支持规则级动作覆盖（mask/hash/drop）
 */

import { HttpReporter } from './reporter';
import { ObservabilityTelemetry } from './telemetry';
import { createLogger, type Logger } from './logger';
import { createOtlpTraceExporter } from './otlp';
import type { SampleStrategyOptions } from './sampling';
import type { W3cTraceContext } from './w3c-trace-context';
import type { RedactAction } from './redact/rules';

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
  /**
   * 【旧兼容】P2-1 明细采样率（0–1）：只对 model/tool spans 与 toolCalls 采样，
   * runs/permissions/events 全量。缺省 1。
   * 新版 sampleStrategy 优先；sampleRate 未设置 sampleStrategy 时等价 traceid-ratio。
   */
  sampleRate?: number;
  /**
   * Phase 9 — 采样策略：错误/慢请求优先或一致性 traceId 采样。
   * 优先级高于 sampleRate。
   *
   * 示例：
   *   // 错误 100% 保留，成功按 10% 采样
   *   sampleStrategy: { strategy: 'error-priority', successRate: 0.1 }
   *   // 同 trace 稳定采/弃（跨明细一致）
   *   sampleStrategy: { strategy: 'traceid-ratio', rate: 0.2 }
   */
  sampleStrategy?: SampleStrategyOptions;
  /** P2-1 脱敏钩子：send 前对整批改写（防 PII 明文上报），在内置脱敏之后执行 */
  redact?: (batch: import('./types').EventBatch) => import('./types').EventBatch;
  /** Phase 9 — 是否启用内置 PII 脱敏（手机号/邮箱/身份证/银行卡/IP）。默认 true。 */
  redactEnabled?: boolean;
  /** Phase 9 — 字段级脱敏动作覆盖：{ phone: 'hash', email: 'drop', idCard: 'drop' } */
  redactOverrides?: Record<string, RedactAction>;
  /** 发布版本（如 '1.3.0'），随每条 run 上报，供收集端按版本聚合对比。缺省不携带 */
  version?: string;
  /**
   * Phase 9 — W3C Trace Context 父链路。
   * - 字符串：traceparent 请求头原值（如 `00-xxxxxx-yyyyyy-01`）
   * - 对象：已解析的 W3cTraceContext
   * 配置后，所有 run 视作其子链路，面板可跨系统跳转。
   */
  traceparent?: string | W3cTraceContext;
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
  /**
   * Phase 9 — 当前链路的 traceparent 字符串（可传给下游 HTTP 调用实现跨系统追踪）。
   * 无 in-flight run 且未配置外部 traceparent 时返回 null。
   */
  currentTraceparent(): string | null;
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
    sampleStrategy: opts.sampleStrategy,
    redact: opts.redact,
    redactEnabled: opts.redactEnabled,
    redactOverrides: opts.redactOverrides,
    appVersion: opts.version,
    traceparent: opts.traceparent,
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
    currentTraceparent: () => telemetry.currentTraceparent(),
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
// Phase 9 新增导出：采样 / W3C / 脱敏
export {
  createSamplingJudge,
  resolveSampleStrategy,
  legacySampleRateToStrategy,
} from './sampling';
export type {
  SampleStrategy,
  SampleStrategyOptions as SamplingOptions,
  SamplingJudge,
} from './sampling';
export {
  parseTraceparent,
  formatTraceparent,
  generateW3cTraceId,
  generateW3cParentId,
} from './w3c-trace-context';
export type { W3cTraceContext } from './w3c-trace-context';
export { BUILTIN_RULES, redactString, redactValue } from './redact/rules';
export type { RedactRule, RedactAction } from './redact/rules';
export type {
  RunRecord,
  SpanRecord,
  ToolCallRecord,
  PermissionRecord,
  EventRecord,
  RetryRecord,
  EventBatch,
} from './types';
