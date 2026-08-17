/**
 * Kafka Consumer — 基于 kafkajs 封装的 MqConsumer 实现。
 *
 * 批量拉取策略：
 * - 使用 kafkajs 原生 eachBatch，遍历 batch.messages
 * - 攒批缓冲：达到 maxBatchSize 或 eachBatch 结束时触发 handler
 * - 攒批超时由 setInterval 兜底（避免低流量时消息积压在缓冲）
 * - handler 成功 → resolveOffset + commitOffsetsIfNecessary；失败 → 抛错触发重投递
 *
 * 错误处理：
 * - handler 抛错 → 整批不 commit，kafkajs 重投递（受 retry 配置限制）
 * - 调用方在 handler 内捕获错误并主动 sendToDlq，避免无限重试
 *
 * 消费组语义：
 * - 同一 groupId 内的 consumer 实例均分 partition
 * - worker 横向扩展：多实例同 groupId，自动 rebalance
 */

import { Kafka, type Consumer, type KafkaConfig, type EachBatchPayload, type SASLOptions } from 'kafkajs';
import type { MqConsumer, MqConsumerOptions, MqConsumeHandler, MqMessage } from './types';

export interface KafkaConsumerOptions extends MqConsumerOptions {
  /** Kafka brokers */
  brokers: string[];
  /** clientId */
  clientId: string;
  /** SASL 鉴权（可选） */
  sasl?: SASLOptions | KafkaConfig['sasl'];
  /** SSL 配置（可选） */
  ssl?: KafkaConfig['ssl'];
  /** 连接超时 ms（默认 10000） */
  connectionTimeoutMs?: number;
  /** 请求超时 ms（默认 30000） */
  requestTimeoutMs?: number;
  /** 重试配置 */
  retry?: KafkaConfig['retry'];
  /** sessionTimeoutMs（默认 30000，超时未心跳则 rebalance） */
  sessionTimeoutMs?: number;
}

export class KafkaMqConsumer implements MqConsumer {
  private kafka: Kafka;
  private consumer: Consumer;
  private maxBatchSize: number;
  private maxBatchMs: number;
  private fromBeginning: boolean;
  private subscribedTopic?: string;
  private running = false;
  /** 攒批缓冲 */
  private buffer: MqMessage[] = [];
  private flushTimer?: NodeJS.Timeout;
  private handler?: MqConsumeHandler;
  /** 当前 eachBatch 的 payload（用于 resolveOffset / commit） */
  private currentPayload?: EachBatchPayload;

  constructor(opts: KafkaConsumerOptions) {
    this.kafka = new Kafka({
      clientId: opts.clientId,
      brokers: opts.brokers,
      sasl: opts.sasl as KafkaConfig['sasl'],
      ssl: opts.ssl,
      connectionTimeout: opts.connectionTimeoutMs,
      requestTimeout: opts.requestTimeoutMs,
      retry: opts.retry,
    });
    this.consumer = this.kafka.consumer({
      groupId: opts.groupId,
      sessionTimeout: opts.sessionTimeoutMs,
    });
    this.maxBatchSize = opts.maxBatchSize ?? 500;
    this.maxBatchMs = opts.maxBatchMs ?? 1000;
    this.fromBeginning = opts.fromBeginning ?? false;
  }

  async subscribe(topic: string, handler: MqConsumeHandler): Promise<void> {
    if (this.running) {
      throw new Error('consumer 已在运行，请先 stop() 再 subscribe');
    }
    this.subscribedTopic = topic;
    this.handler = handler;
    await this.consumer.connect();
    await this.consumer.subscribe({ topic, fromBeginning: this.fromBeginning });

    // 攒批超时兜底：低流量时按 maxBatchMs flush 缓冲
    this.flushTimer = setInterval(() => {
      void this.flushBuffer();
    }, this.maxBatchMs);
    this.flushTimer.unref?.();

    this.running = true;
    await this.consumer.run({
      autoCommit: false,
      eachBatch: async (payload: EachBatchPayload) => {
        this.currentPayload = payload;
        const partition = payload.batch.partition;
        for (const message of payload.batch.messages) {
          this.buffer.push({
            topic,
            partition,
            offset: message.offset,
            key: message.key?.toString(),
            value: message.value?.toString() ?? '',
            timestamp: message.timestamp,
          });
          // 标记已接收（不等于已处理；handler 成功后才 commit）
          payload.resolveOffset(message.offset);
          if (this.buffer.length >= this.maxBatchSize) {
            await this.flushBuffer();
          }
          await payload.heartbeat();
        }
        // eachBatch 结束时 flush 残留缓冲
        if (this.buffer.length > 0) {
          await this.flushBuffer();
        }
        this.currentPayload = undefined;
      },
    });
  }

  /** flush 缓冲：调用 handler → 成功 commit；失败抛错（kafkajs 重投递） */
  private async flushBuffer(): Promise<void> {
    if (this.buffer.length === 0 || !this.handler) return;
    const messages = this.buffer.splice(0, this.buffer.length);
    try {
      await this.handler(messages);
      // 成功 → commit 已 resolve 的 offset
      if (this.currentPayload) {
        await this.currentPayload.commitOffsetsIfNecessary();
      }
    } catch (err) {
      // 失败 → 不 commit；kafkajs 会因 eachBatch 抛错而重投递
      // 把消息放回缓冲头部，便于下次重试（仅日志分析用，实际重投递由 kafkajs 控制）
      console.error('[KafkaMqConsumer] handler 失败，消息将重投递:', err);
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
    // 停止前 flush 残留缓冲（best-effort，失败不阻塞）
    if (this.buffer.length > 0) {
      try {
        await this.flushBuffer();
      } catch (err) {
        console.warn('[KafkaMqConsumer] 停止时 flush 残留失败:', err);
      }
    }
    await this.consumer.stop();
  }

  async close(): Promise<void> {
    await this.stop();
    try {
      await this.consumer.disconnect();
    } catch {
      // 忽略：可能已断开
    }
  }
}
