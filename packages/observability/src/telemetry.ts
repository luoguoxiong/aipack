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
  /** P2-1 明细采样率（0–1）：只作用于 model/tool spans 与 toolCalls；runs/permissions/events 全量。缺省 1（全量） */
  sampleRate?: number;
  /** P2-1 脱敏钩子：send 前对整批改写（防 PII 明文上报） */
  redact?: (batch: EventBatch) => EventBatch;
}

const emptyBatch = (): EventBatch => ({
  runs: [],
  spans: [],
  toolCalls: [],
  permissions: [],
  retries: [],
  events: [],
});

export class ObservabilityTelemetry implements Telemetry {
  private queued: EventBatch = emptyBatch();
  private timer: NodeJS.Timeout | undefined;
  private startedAt = new Map<string, number>(); // traceId -> queuedAt
  /** in-flight run 顺序（最近开始的排最后），供 logger 关联当前 traceId */
  private inFlightOrder: string[] = [];
  private batchSize: number;
  private sampleRate: number;
  private redact?: (batch: EventBatch) => EventBatch;

  constructor(private reporter: { send(batch: EventBatch): Promise<boolean> }, opts: FlushQueueOptions = {}) {
    this.batchSize = opts.batchSize ?? 50;
    this.sampleRate = opts.sampleRate ?? 1;
    this.redact = opts.redact;
    const intervalMs = opts.intervalMs ?? 5000;
    this.timer = setInterval(() => void this.flush(), intervalMs);
    this.timer.unref?.();
  }

  onRunStart = (info: RunStartTelemetryInfo): void => {
    this.startedAt.set(info.traceId, info.queuedAt);
    this.inFlightOrder = this.inFlightOrder.filter((id) => id !== info.traceId);
    this.inFlightOrder.push(info.traceId);
  };

  onRunEnd = (info: RunTelemetryInfo): void => {
    const queuedAt = this.startedAt.get(info.traceId) ?? Date.now() - info.durationMs;
    this.startedAt.delete(info.traceId);
    this.inFlightOrder = this.inFlightOrder.filter((id) => id !== info.traceId);

    this.queued.runs.push(this.runRecord(info, queuedAt));
    this.queued.spans.push(this.runSpan(info, queuedAt));
    this.maybeFlush();
  };

  onToolCall = (info: ToolTelemetryInfo): void => {
    if (!this.sample()) return; // P2-1 明细采样
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
    if (!this.sample()) return; // P2-1 明细采样
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

  onRetry = (info: RetryTelemetryInfo): void => {
    // P2-2：per-attempt 重试明细（关联 model span），server 落 retry_attempts 表
    this.queued.retries.push({
      traceId: info.traceId,
      spanId: info.spanId,
      provider: info.provider,
      modelId: info.modelId,
      attempt: info.attempt,
      errorClass: info.errorClass,
      status: info.status,
      delayMs: info.delayMs,
      timestamp: Date.now(),
    });
    this.maybeFlush();
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

  /**
   * 当前 run 上下文（供结构化 logger 注入 traceId）。
   * 单并发时返回唯一 in-flight run；并发时返回最近开始的（约定语义，文档说明）。
   */
  currentContext(): { traceId?: string } {
    const traceId = this.inFlightOrder[this.inFlightOrder.length - 1];
    return traceId ? { traceId } : {};
  }

  /**
   * P2-1 自定义业务事件（通用埋点）。
   * run 内调用自动注入当前 traceId；run 外可通过 opts 显式传 traceId/sessionKey。
   */
  emit(name: string, data?: unknown, opts: { traceId?: string; sessionKey?: string } = {}): void {
    this.queued.events.push({
      traceId: opts.traceId ?? this.currentContext().traceId,
      sessionKey: opts.sessionKey,
      name,
      data,
      timestamp: Date.now(),
    });
    this.maybeFlush();
  }

  /** 立即上报队列中残留的数据（fire-and-forget，失败由 reporter 缓存补报） */
  flush(): void {
    if (this.isEmpty()) return;
    const batch = this.queued;
    this.queued = emptyBatch();
    void this.reporter.send(this.redact ? this.redact(batch) : batch);
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
    await this.reporter.send(this.redact ? this.redact(batch) : batch);
  }

  /** P2-1 明细采样判定：rate>=1 恒过、<=0 恒弃、否则按概率 */
  private sample(): boolean {
    if (this.sampleRate >= 1) return true;
    if (this.sampleRate <= 0) return false;
    return Math.random() < this.sampleRate;
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
      !this.queued.permissions.length &&
      !this.queued.retries.length &&
      !this.queued.events.length
    );
  }

  private maybeFlush(): void {
    const total =
      this.queued.runs.length +
      this.queued.spans.length +
      this.queued.toolCalls.length +
      this.queued.permissions.length +
      this.queued.retries.length +
      this.queued.events.length;
    if (total >= this.batchSize) this.flush();
  }
}
