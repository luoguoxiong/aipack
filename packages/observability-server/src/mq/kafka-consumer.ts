/**
 * Kafka Consumer — 基于 kafkajs 封装的 MqConsumer 实现。
 *
 * 批量策略：
 * - 使用 kafkajs 原生 eachBatch，按 maxBatchSize 切块交给 handler
 * - 低流量不积压：kafkajs 每次 fetch 都回调 eachBatch（batch 天然按到达切分），
 *   无需额外攒批定时器
 *
 * offset 语义（D1 修复，at-least-once）：
 * - 显式 eachBatchAutoResolve: false（禁止 kafkajs 在 eachBatch 结束时自动提交）
 * - 仅当前块 handler 成功后才 resolveOffset(块内最后一条) + commit
 * - handler 失败 → 抛错，已成功的块已提交、失败块未 resolve → 重投递从失败块开始
 *
 * 错误处理：
 * - handler 抛错 → 整块不 commit，kafkajs 重投递（受 retry 配置限制）
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
    // 保留字段（兼容配置接口）：kafkajs fetch 自身管理批延迟，此值仅作为切块参考
    this.maxBatchMs = opts.maxBatchMs ?? 1000;
    this.fromBeginning = opts.fromBeginning ?? false;
  }

  async subscribe(topic: string, handler: MqConsumeHandler): Promise<void> {
    if (this.running) {
      throw new Error('consumer 已在运行，请先 stop() 再 subscribe');
    }
    this.subscribedTopic = topic;
    this.running = true;
    await this.consumer.connect();
    await this.consumer.subscribe({ topic, fromBeginning: this.fromBeginning });

    await this.consumer.run({
      autoCommit: false,
      // D1 修复：显式关闭自动 resolve（默认 true 会在 eachBatch 正常结束后
      // 自动提交最后一条 offset，与"处理成功才提交"的手动语义冲突）
      eachBatchAutoResolve: false,
      eachBatch: async (payload: EachBatchPayload) => {
        const partition = payload.batch.partition;
        const messages: MqMessage[] = payload.batch.messages.map((m) => ({
          topic,
          partition,
          offset: m.offset,
          key: m.key?.toString(),
          value: m.value?.toString() ?? '',
          timestamp: m.timestamp,
        }));

        // 按 maxBatchSize 切块：每块 handler 成功才 resolve 该块尾部 offset。
        // 块 N 失败抛错时：块 1..N-1 已提交 → 重投递从块 N 开始，不重复不丢失。
        for (let i = 0; i < messages.length; i += this.maxBatchSize) {
          const chunk = messages.slice(i, i + this.maxBatchSize);
          try {
            await handler(chunk);
          } catch (err) {
            // 失败块不 resolve；抛错让 kafkajs 从已提交位置重投递
            console.error('[KafkaMqConsumer] handler 失败，本块将重投递:', err);
            throw err;
          }
          // D1 修复：处理成功后才 resolve（kafkajs 提交全部已 resolve 的最大 offset）
          const lastOffset = messages[i + chunk.length - 1]?.offset;
          if (lastOffset !== undefined) payload.resolveOffset(lastOffset);
          await payload.commitOffsetsIfNecessary();
          await payload.heartbeat();
        }
      },
    });
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
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
