/**
 * Telemetry 接口实现（客户端 SDK）：事件 → 原始记录 → 上报队列 → HttpReporter。
 *
 * 埋点模式：不在本地聚合/落盘，事件同步转成 RunRecord / SpanRecord / ToolCallRecord /
 * PermissionRecord 后入队，由定时器批量 POST 到收集服务。上报失败由 reporter 缓存补报，
 * 事件路径零阻塞、失败不阻断 run()。
 *
 * 载荷无 startedAt 字段：用「到达时刻 - durationMs」推导；run 级用 onRunStart.queuedAt。
 *
 * 注意：runtime 的 emitTelemetry 会解构方法后调用（fn(info)），故所有回调必须为
 * 箭头函数属性以绑定 this，否则 this.queued / this.startedAt 为 undefined。
 */

import type {
  Telemetry,
  RunStartTelemetryInfo,
  RunTelemetryInfo,
  ToolTelemetryInfo,
  ModelTelemetryInfo,
  RetryTelemetryInfo,
  PermissionDeniedTelemetryInfo,
} from '@aipack/agent';
import type { RunRecord, SpanRecord, ToolCallRecord, PermissionRecord, EventBatch } from './types';

export interface FlushQueueOptions {
  /** 上报周期（ms），默认 5000 */
  intervalMs?: number;
  /** 积攒条数触发（含 runs/spans/toolCalls/permissions 总数），默认 50 */
  batchSize?: number;
}

const emptyBatch = (): EventBatch => ({ runs: [], spans: [], toolCalls: [], permissions: [] });

export class ObservabilityTelemetry implements Telemetry {
  private queued: EventBatch = emptyBatch();
  private timer: NodeJS.Timeout | undefined;
  private startedAt = new Map<string, number>(); // traceId -> queuedAt
  private batchSize: number;

  constructor(private reporter: { send(batch: EventBatch): Promise<boolean> }, opts: FlushQueueOptions = {}) {
    this.batchSize = opts.batchSize ?? 50;
    const intervalMs = opts.intervalMs ?? 5000;
    this.timer = setInterval(() => void this.flush(), intervalMs);
    this.timer.unref?.();
  }

  onRunStart = (info: RunStartTelemetryInfo): void => {
    this.startedAt.set(info.traceId, info.queuedAt);
  };

  onRunEnd = (info: RunTelemetryInfo): void => {
    const queuedAt = this.startedAt.get(info.traceId) ?? Date.now() - info.durationMs;
    this.startedAt.delete(info.traceId);

    this.queued.runs.push(this.runRecord(info, queuedAt));
    this.queued.spans.push(this.runSpan(info, queuedAt));
    this.maybeFlush();
  };

  onToolCall = (info: ToolTelemetryInfo): void => {
    const startedAt = Date.now() - info.durationMs;
    this.queued.spans.push({
      traceId: info.traceId,
      spanId: info.spanId,
      kind: 'tool',
      name: `tool:${info.toolName}`,
      startedAt,
      durationMs: info.durationMs,
      status: info.status === 'ok' ? 'ok' : 'error',
      errorClass: info.errorClass,
      sessionKey: info.sessionKey,
    });
    this.queued.toolCalls.push({
      traceId: info.traceId,
      spanId: info.spanId,
      toolName: info.toolName,
      status: info.status,
      durationMs: info.durationMs,
      errorClass: info.errorClass,
    });
    this.maybeFlush();
  };

  onModelCall = (info: ModelTelemetryInfo): void => {
    this.queued.spans.push({
      traceId: info.traceId,
      spanId: info.spanId,
      kind: 'model',
      name: `model:${info.modelId}`,
      startedAt: Date.now() - info.durationMs,
      durationMs: info.durationMs,
      status: info.errorClass ? 'error' : 'ok',
      errorClass: info.errorClass,
      attempts: info.attempts,
      inputTokens: info.inputTokens,
      outputTokens: info.outputTokens,
      costUsd: info.costUsd,
      sessionKey: info.sessionKey,
    });
    this.maybeFlush();
  };

  onRetry = (_info: RetryTelemetryInfo): void => {
    // 重试率由 onModelCall.attempts 统计，此处不重复上报
  };

  onPermissionDenied = (info: PermissionDeniedTelemetryInfo): void => {
    this.queued.permissions.push({
      traceId: info.traceId,
      sessionKey: info.sessionKey,
      toolName: info.toolName,
      reason: info.reason,
      timestamp: Date.now(),
    });
    this.maybeFlush();
  };

  /** 立即上报队列中残留的数据（fire-and-forget，失败由 reporter 缓存补报） */
  flush(): void {
    if (this.isEmpty()) return;
    const batch = this.queued;
    this.queued = emptyBatch();
    void this.reporter.send(batch);
  }

  /** 停止定时器并等残留上报完成（进程退出前调用） */
  async close(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.isEmpty()) return;
    const batch = this.queued;
    this.queued = emptyBatch();
    await this.reporter.send(batch);
  }

  private runRecord(info: RunTelemetryInfo, queuedAt: number): RunRecord {
    return {
      traceId: info.traceId,
      startedAt: queuedAt,
      endedAt: queuedAt + info.durationMs,
      sessionKey: info.sessionKey,
      channel: info.request.channel,
      model: info.request.model,
      status: info.success
        ? 'success'
        : info.errorClass === 'validation'
          ? 'validation'
          : 'error',
      errorClass: info.errorClass,
      turns: info.turnCount,
      durationMs: info.durationMs,
      activeMs: info.activeMs,
      queuedMs: info.queuedMs,
      ttftMs: info.ttftMs,
      inputTokens: info.tokens.input,
      outputTokens: info.tokens.output,
      cacheRead: info.tokens.cacheRead,
      cacheWrite: info.tokens.cacheWrite,
      costUsd: info.costUsd,
    };
  }

  private runSpan(info: RunTelemetryInfo, queuedAt: number): SpanRecord {
    return {
      traceId: info.traceId,
      spanId: info.traceId,
      kind: 'run',
      name: 'run',
      startedAt: queuedAt,
      durationMs: info.durationMs,
      status: info.success ? 'ok' : 'error',
      errorClass: info.errorClass,
      inputTokens: info.tokens.input,
      outputTokens: info.tokens.output,
      costUsd: info.costUsd,
      sessionKey: info.sessionKey,
    };
  }

  private isEmpty(): boolean {
    return (
      !this.queued.runs.length &&
      !this.queued.spans.length &&
      !this.queued.toolCalls.length &&
      !this.queued.permissions.length
    );
  }

  private maybeFlush(): void {
    const total =
      this.queued.runs.length +
      this.queued.spans.length +
      this.queued.toolCalls.length +
      this.queued.permissions.length;
    if (total >= this.batchSize) this.flush();
  }
}
