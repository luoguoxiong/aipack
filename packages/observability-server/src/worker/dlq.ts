/**
 * DLQ（死信队列）处理器（Phase 3）。
 *
 * 用途：ingest-worker 消费失败的消息进 DLQ topic（aipack.ingest.dlq），
 *       本模块提供：
 *       - `sendToDlq`：worker 处理失败时调用，附带失败原因
 *       - `DlqMonitor`：定时拉取 DLQ 计数，超阈值告警（Phase 3 监控 DLQ 速率）
 *
 * 设计：
 * - DLQ 消息体见 mq/types.ts DlqMessage（含 original / reason / attempts / failedAt）
 * - DLQ topic 留存 30 天（infra/docker-compose.yml 中配置 retention.ms=2592000000）
 * - 监控：暴露 dlqCount 指标，供告警评估器消费（Phase 3 后接 alerts/evaluator）
 */

import type { MqProducer } from '../mq/types';
import { encodeDlqMessage, type DlqMessage } from '../mq/types';

export interface DlqSendOptions {
  /** 原始消息 value（IngestMessage JSON 字符串） */
  originalValue: string;
  /** 失败原因（错误 message） */
  reason: string;
  /** 已重试次数（默认 1，多次重试后累加） */
  attempts?: number;
  /** 消息 key（沿用原消息 key，便于按应用分区） */
  key?: string;
}

/**
 * 发送消息到 DLQ。
 *
 * worker 在 handler 抛错且重试达上限后调用此函数。
 * 失败原因会同时写入消息 headers，便于 Kafka 端过滤分析。
 */
export async function sendToDlq(producer: MqProducer, opts: DlqSendOptions): Promise<void> {
  const payload: DlqMessage = {
    original: opts.originalValue,
    reason: opts.reason,
    attempts: opts.attempts ?? 1,
    failedAt: Date.now(),
  };
  // sendToDlq 由 KafkaMqProducer 内部编码（含 headers），此处直接传原始 reason
  await producer.sendToDlq(opts.originalValue, opts.reason, {
    key: opts.key,
    headers: {
      'dlq-attempts': String(payload.attempts),
      'dlq-reason': opts.reason.slice(0, 200),
    },
  });
  // 编码后的 payload 通过 producer 的 value 字段已发送（sendToDlq 内部用 encodeDlqMessage）
  // 此处 encodeDlqMessage 仅供日志/监控用，不重复发送
  void encodeDlqMessage(payload);
}

/**
 * DLQ 速率监控器。
 *
 * - 定时（默认 60s）拉取 DLQ topic 的 consumer lag 或最近消息数
 * - 超阈值时调用 onAlert 回调（接入 alerts/evaluator 或独立通知）
 *
 * 简化实现：本版本仅维护内存计数（worker 每次发送 DLQ 时调用 record），
 *           完整的 Kafka lag 监控留待 Phase 7（Redis 共享计数）。
 */
export class DlqMonitor {
  private count = 0;
  private windowStart = Date.now();
  private threshold: number;
  private intervalMs: number;
  private onAlert: (count: number, windowMs: number) => void;
  private timer?: NodeJS.Timeout;

  constructor(opts: {
    /** 窗口内 DLQ 计数阈值（默认 10） */
    threshold?: number;
    /** 窗口长度 ms（默认 60000） */
    intervalMs?: number;
    /** 超阈值回调 */
    onAlert: (count: number, windowMs: number) => void;
  }) {
    this.threshold = opts.threshold ?? 10;
    this.intervalMs = opts.intervalMs ?? 60_000;
    this.onAlert = opts.onAlert;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.check(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** 记录一次 DLQ 发送（worker 调用） */
  record(): void {
    this.count++;
  }

  private check(): void {
    const now = Date.now();
    const elapsed = now - this.windowStart;
    if (this.count >= this.threshold) {
      this.onAlert(this.count, elapsed);
    }
    // 重置窗口
    this.count = 0;
    this.windowStart = now;
  }

  /** 当前窗口计数（测试用） */
  currentCount(): number {
    return this.count;
  }
}
