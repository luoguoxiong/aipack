/**
 * @aipack/observability — aipack 可观测性上报 SDK。
 *
 * 埋点上报模式：客户端只需 appId + appSecret，6 类 Telemetry 事件自动批量
 * POST 到收集服务（默认 http://localhost:8787），失败本地缓存补报。
 *
 *   const obs = createObservability({ appId: 'my-app', appSecret: 'xxx' });
 *   createRuntime({ ..., telemetry: obs.telemetry });
 *
 * 收集服务见 @aipack/observability-server（独立包，SQLite 落盘 + 内存聚合 + REST API）。
 */

import { HttpReporter } from './reporter';
import { ObservabilityTelemetry } from './telemetry';

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
}

export interface Observability {
  /** 注入 RuntimeOptions.telemetry */
  telemetry: ObservabilityTelemetry;
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
  const telemetry = new ObservabilityTelemetry(reporter, {
    intervalMs: opts.flushIntervalMs,
    batchSize: opts.flushBatchSize,
  });

  return {
    telemetry,
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
export type {
  RunRecord,
  SpanRecord,
  ToolCallRecord,
  PermissionRecord,
  EventBatch,
} from './types';
