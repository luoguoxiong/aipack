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
 *
 * Phase 9 新增：
 *  - 采样策略：error-priority / slow-priority / traceid-ratio（整 run 维度 + 明细联动）
 *  - W3C Trace Context：traceparent 头解析 → parentTraceId/w3cTraceId 写入 RunRecord
 *  - PII 脱敏：内置规则库深度遍历 events.data 做脱敏（默认启用，可关闭）
 */

import type {
  Telemetry,
  RunStartTelemetryInfo,
  RunTelemetryInfo,
  ToolTelemetryInfo,
  ModelTelemetryInfo,
  RetryTelemetryInfo,
  PermissionDeniedTelemetryInfo,
} from '@aipack-ai/agent';
import type { RunRecord, SpanRecord, ToolCallRecord, PermissionRecord, EventBatch } from './types';
import {
  createSamplingJudge,
  legacySampleRateToStrategy,
  resolveSampleStrategy,
  type SampleStrategy,
  type SampleStrategyOptions,
  type SamplingJudge,
} from './sampling';
import {
  parseTraceparent,
  generateW3cTraceId,
  generateW3cParentId,
  formatTraceparent,
  type W3cTraceContext,
} from './w3c-trace-context';
import { redactValue, type RedactAction } from './redact/rules';

export interface FlushQueueOptions {
  /** 上报周期（ms），默认 5000 */
  intervalMs?: number;
  /** 积攒条数触发（含 runs/spans/toolCalls/permissions 总数），默认 50 */
  batchSize?: number;
  /** 【旧兼容】P2-1 明细采样率（0–1）：只作用于 model/tool spans 与 toolCalls；runs/permissions/events 全量。
   *  新版 sampleStrategy 优先，sampleRate 仅在未配置 sampleStrategy 时生效（等价 traceid-ratio）。 */
  sampleRate?: number;
  /** Phase 9 — 采样策略（error-priority / slow-priority / traceid-ratio）。优先级高于 sampleRate。 */
  sampleStrategy?: SampleStrategyOptions;
  /** P2-1 脱敏钩子：send 前对整批改写（防 PII 明文上报）。
   *  当内置脱敏启用时，自定义钩子在内置之后执行（用户可进一步定制）。 */
  redact?: (batch: EventBatch) => EventBatch;
  /** Phase 9 — 是否启用内置 PII 脱敏规则（手机号/邮箱/身份证/银行卡/IP）。默认 true。 */
  redactEnabled?: boolean;
  /** Phase 9 — 字段级脱敏动作覆盖：{ phone: 'hash', email: 'drop' }。未配置规则走默认 mask。 */
  redactOverrides?: Record<string, RedactAction>;
  /** 发布版本：注入每条 run 记录（RunRecord.appVersion），供收集端按版本聚合。缺省不携带 */
  appVersion?: string;
  /**
   * Phase 9 — 外部 traceparent 上下文（来自 HTTP 请求头 / 消息队列属性）。
   * 传入字符串时自动解析；解析失败则忽略（不影响正常上报）。
   */
  traceparent?: string | W3cTraceContext;
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
  private redact?: (batch: EventBatch) => EventBatch;
  private appVersion?: string;
  private redactEnabled: boolean;
  private redactOverrides?: Record<string, RedactAction>;

  // ─── Phase 9：采样 ───────────────────────────────────────────────
  private sampleStrategy: SampleStrategy;
  private judge: SamplingJudge;

  // ─── Phase 9：W3C Trace Context ──────────────────────────────────
  /** 外部传入的 traceparent 上下文（共享：所有 run 视作其子链路） */
  private w3cCtx: W3cTraceContext | null;
  /** traceId → 为该 run 生成的 w3c trace 数据（上报时注入 RunRecord） */
  private w3cByRun = new Map<string, { w3cTraceId: string; parentTraceId?: string }>();

  constructor(private reporter: { send(batch: EventBatch): Promise<boolean> }, opts: FlushQueueOptions = {}) {
    this.batchSize = opts.batchSize ?? 50;
    this.redact = opts.redact;
    this.appVersion = opts.appVersion;
    this.redactEnabled = opts.redactEnabled ?? true;
    this.redactOverrides = opts.redactOverrides;

    // ─── 采样策略：sampleStrategy 优先；缺省退回 sampleRate（兼容旧语义）；都未配置 = none ───
    if (opts.sampleStrategy && opts.sampleStrategy.strategy) {
      this.sampleStrategy = resolveSampleStrategy(opts.sampleStrategy);
    } else {
      this.sampleStrategy = legacySampleRateToStrategy(opts.sampleRate);
    }
    this.judge = createSamplingJudge(this.sampleStrategy);

    // ─── W3C traceparent ─────────────────────────────────────────
    this.w3cCtx = parseTraceparentInput(opts.traceparent);

    const intervalMs = opts.intervalMs ?? 5000;
    this.timer = setInterval(() => void this.flush(), intervalMs);
    this.timer.unref?.();
  }

  onRunStart = (info: RunStartTelemetryInfo): void => {
    this.startedAt.set(info.traceId, info.queuedAt);
    this.inFlightOrder = this.inFlightOrder.filter((id) => id !== info.traceId);
    this.inFlightOrder.push(info.traceId);

    // Phase 9：为该 run 生成 W3C 上下文（即使外部未传入也生成自身 w3cTraceId，便于面板统一展示）
    const parent = this.w3cCtx;
    const w3cTraceId = parent ? parent.traceId : generateW3cTraceId();
    const parentTraceId = parent ? parent.traceId : undefined;
    this.w3cByRun.set(info.traceId, { w3cTraceId, parentTraceId });
  };

  onRunEnd = (info: RunTelemetryInfo): void => {
    const queuedAt = this.startedAt.get(info.traceId) ?? Date.now() - info.durationMs;
    this.startedAt.delete(info.traceId);
    this.inFlightOrder = this.inFlightOrder.filter((id) => id !== info.traceId);

    // Phase 9：整 run 采样判定（必须先判定，才能联动明细 shouldKeepDetail）
    const keep = this.judge.shouldKeepRun({
      traceId: info.traceId,
      status: info.success
        ? 'success'
        : info.errorClass === 'validation'
          ? 'validation'
          : 'error',
      durationMs: info.durationMs,
    });
    if (!keep) {
      this.w3cByRun.delete(info.traceId);
      return;
    }

    const run = this.runRecord(info, queuedAt);
    this.queued.runs.push(run);
    this.queued.spans.push(this.runSpan(info, queuedAt));
    this.maybeFlush();
  };

  onToolCall = (info: ToolTelemetryInfo): void => {
    if (!this.judge.shouldKeepDetail(info.traceId)) return; // Phase 9：采样联动
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
    if (!this.judge.shouldKeepDetail(info.traceId)) return; // Phase 9：采样联动
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
      cacheRead: info.cacheRead,
      cacheWrite: info.cacheWrite,
      sessionKey: info.sessionKey,
    });
    this.maybeFlush();
  };

  onRetry = (info: RetryTelemetryInfo): void => {
    if (!this.judge.shouldKeepDetail(info.traceId)) return; // Phase 9：采样联动（重试只保留已采 runs）
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
    // 权限事件一般数量少，全量保留（不参与采样，便于安全审计）
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
   * Phase 9：内置 PII 脱敏在 flush 阶段对 data 深度遍历。
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

  /** Phase 9 — 主动读取/注入当前 W3C traceparent（可传给下游 HTTP 调用）。 */
  currentTraceparent(): string | null {
    const traceId = this.currentContext().traceId;
    if (!traceId) {
      // 无 in-flight run：若有共享外部 ctx，返回父 spanId；否则生成一次性
      if (this.w3cCtx) return this.w3cCtx.raw;
      return null;
    }
    const w3c = this.w3cByRun.get(traceId);
    const w3cTraceId = w3c?.w3cTraceId ?? (this.w3cCtx?.traceId ?? generateW3cTraceId());
    // 把 aipack traceId 截断/映射为 16 hex 的 spanId（deterministic）
    const parentId = aipackSpanIdToW3c(traceId);
    return formatTraceparent({ traceId: w3cTraceId, parentId, sampled: true });
  }

  /** 立即上报队列中残留的数据（fire-and-forget，失败由 reporter 缓存补报） */
  flush(): void {
    if (this.isEmpty()) return;
    const batch = this.queued;
    this.queued = emptyBatch();
    let final = batch;
    // Phase 9：内置 PII 脱敏（先内置规则，再用户自定义 redact 钩子）
    if (this.redactEnabled) {
      final = applyBuiltinRedact(final, this.redactOverrides);
    }
    if (this.redact) final = this.redact(final);
    void this.reporter.send(final);
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
    let final = batch;
    if (this.redactEnabled) final = applyBuiltinRedact(final, this.redactOverrides);
    if (this.redact) final = this.redact(final);
    await this.reporter.send(final);
  }

  private runRecord(info: RunTelemetryInfo, queuedAt: number): RunRecord {
    const w3c = this.w3cByRun.get(info.traceId);
    this.w3cByRun.delete(info.traceId);
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
      ...(this.appVersion !== undefined ? { appVersion: this.appVersion } : {}),
      ...(w3c?.parentTraceId !== undefined ? { parentTraceId: w3c.parentTraceId } : {}),
      ...(w3c?.w3cTraceId !== undefined ? { w3cTraceId: w3c.w3cTraceId } : {}),
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

// ─── 工具 ─────────────────────────────────────────────────────────

/** 对整批 EventBatch 应用内置 PII 脱敏 */
function applyBuiltinRedact(batch: EventBatch, overrides?: Record<string, RedactAction>): EventBatch {
  // events.data 深度遍历（最可能含 PII 的自由字段）
  const events = batch.events.map((e) =>
    e.data === undefined ? e : { ...e, data: redactValue(e.data, overrides) },
  );
  // permissions.reason 可能带用户输入
  const permissions = batch.permissions.map((p) => ({
    ...p,
    reason: redactString(p.reason, overrides),
  }));
  return {
    runs: batch.runs, // runs 字段结构化，不做默认脱敏（避免破坏聚合）
    spans: batch.spans,
    toolCalls: batch.toolCalls,
    retries: batch.retries,
    events,
    permissions,
  };
}

/** 兼容用户输入：字符串或结构化对象 */
function parseTraceparentInput(input: string | W3cTraceContext | undefined): W3cTraceContext | null {
  if (!input) return null;
  if (typeof input === 'string') {
    const r = parseTraceparent(input);
    return r.ok ? r.ctx : null;
  }
  // 结构化对象
  return input && typeof input.traceId === 'string' ? input : null;
}

/** aipack traceId → 16 hex W3C parentId（deterministic：FNV-1a 截断） */
function aipackSpanIdToW3c(aipackTraceId: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < aipackTraceId.length; i++) {
    h ^= aipackTraceId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const hex = (h >>> 0).toString(16).padStart(8, '0');
  // 16 hex 需要再补 8：后半段用简单二次哈希
  let h2 = 0x84222325;
  for (let i = aipackTraceId.length - 1; i >= 0; i--) {
    h2 ^= aipackTraceId.charCodeAt(i);
    h2 = Math.imul(h2, 0x01000193);
  }
  const hex2 = (h2 >>> 0).toString(16).padStart(8, '0');
  const out = hex + hex2;
  if (/^0{16}$/.test(out)) return '0000000000000001';
  return out;
}

/** 复用 rules.ts 的字符串脱敏（避免 circular import：此处内联简单 wrap） */
function redactString(raw: string, overrides?: Record<string, RedactAction>): string {
  return redactValue<string>(raw, overrides);
}
