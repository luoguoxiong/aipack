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

import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
 * DLQ 兜底 outbox（D3 修复）。
 *
 * 问题：DLQ produce 失败时消息既未落库也未进 DLQ（offset 照常提交）→ 消息蒸发。
 * 修复：发送失败时把 DLQ 投递任务追加到本地 JSONL 文件；worker 定期 replay()
 * 重发到 DLQ topic，成功一条删一条。
 *
 * - 单文件 + 追加写：崩溃安全（每行一个 JSON，最多丢最后一次未 flush 的追加）
 * - maxFileSize 上限：防止 DLQ 长期不可用撑爆磁盘（超限丢弃最旧并告警）
 */
export class DlqOutbox {
  private filePath: string;
  private maxFileSize: number;
  private replaying = false;

  constructor(opts: { dir?: string; maxFileSize?: number } = {}) {
    const dir = opts.dir ?? process.env.DLQ_OUTBOX_DIR ?? '.aipack/dlq-outbox';
    mkdirSync(dir, { recursive: true });
    this.filePath = join(dir, 'pending.jsonl');
    this.maxFileSize = opts.maxFileSize ?? 64 * 1024 * 1024; // 64MB
  }

  /** 追加一条待重发的 DLQ 投递任务 */
  append(opts: DlqSendOptions): void {
    try {
      const line = JSON.stringify({ ...opts, queuedAt: Date.now() }) + '\n';
      appendFileSync(this.filePath, line, 'utf8');
      const size = this.fileSize();
      if (size > this.maxFileSize) {
        console.error(
          `[DlqOutbox] 文件超限（${size} > ${this.maxFileSize}），保留最新一半条目`,
        );
        this.truncateToHalf();
      }
    } catch (err) {
      // outbox 自身失败（磁盘满等）只能告警：此时消息无法挽回
      console.error('[DlqOutbox] 本地落盘失败（消息将丢失）:', err);
    }
  }

  /** 待重发条目数 */
  pendingCount(): number {
    return this.readLines().length;
  }

  /** 重发 outbox 中的全部条目到 DLQ；成功一条删一条（串行，避免乱序） */
  async replay(producer: MqProducer): Promise<number> {
    if (this.replaying) return 0;
    this.replaying = true;
    let sent = 0;
    try {
      const lines = this.readLines();
      for (let i = 0; i < lines.length; i++) {
        const entry = lines[i];
        try {
          await sendToDlq(producer, {
            originalValue: entry.originalValue,
            reason: entry.reason,
            attempts: entry.attempts,
            key: entry.key,
          });
          sent++;
          // 成功一条删一条：写回剩余行（i+1 起的未处理行 + 保留当前行之前的失败行已重写过）
          // 简化：成功后立即重写剩余未处理行
          writeFileSync(this.filePath, lines.slice(i + 1).map((l) => JSON.stringify(l) + '\n').join(''), 'utf8');
        } catch {
          // DLQ 仍不可用：保留剩余行（含当前），下次再试
          writeFileSync(this.filePath, lines.slice(i).map((l) => JSON.stringify(l) + '\n').join(''), 'utf8');
          break;
        }
      }
      if (sent > 0) {
        console.log(`[DlqOutbox] 重发 ${sent} 条到 DLQ，剩余 ${this.pendingCount()} 条`);
      }
    } finally {
      this.replaying = false;
    }
    return sent;
  }

  private readLines(): Array<DlqSendOptions & { queuedAt: number }> {
    try {
      const content = readFileSync(this.filePath, 'utf8');
      return content
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  }

  private fileSize(): number {
    try {
      return statSync(this.filePath).size;
    } catch {
      return 0;
    }
  }

  /** 超限时丢弃最旧一半条目（保留较新的失败上下文） */
  private truncateToHalf(): void {
    const lines = this.readLines();
    const keep = lines.slice(Math.floor(lines.length / 2));
    writeFileSync(this.filePath, keep.map((l) => JSON.stringify(l) + '\n').join(''), 'utf8');
  }
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
