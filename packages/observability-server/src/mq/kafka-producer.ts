/**
 * Kafka Producer — 基于 kafkajs 封装的 MqProducer 实现。
 *
 * 特性：
 * - 主 topic `aipack.ingest`：collector 鉴权后的 ingest 批量写入
 * - DLQ topic `aipack.ingest.dlq`：worker 处理失败的消息归档
 * - 连接复用：单 producer 实例支持多 topic 发送（kafkajs 内部连接池）
 * - 优雅关闭：close() 等待 in-flight 消息发完
 *
 * 配置：
 * - brokers：Kafka bootstrap servers（如 localhost:9094）
 * - clientId：客户端标识（日志/监控用）
 * - 主 topic / DLQ topic 名（可覆盖默认）
 *
 * 注意：kafkajs 是纯 JS 实现，无原生依赖，跨平台友好。
 */

import { Kafka, type Producer, type KafkaConfig } from 'kafkajs';
import type { MqProducer, MqProduceOptions } from './types';
import { TOPIC_INGEST, TOPIC_DLQ, encodeDlqMessage } from './types';

export interface KafkaProducerOptions {
  /** Kafka brokers，如 ['localhost:9094'] */
  brokers: string[];
  /** clientId（日志/监控用） */
  clientId: string;
  /** 主 topic（默认 aipack.ingest） */
  topic?: string;
  /** DLQ topic（默认 aipack.ingest.dlq） */
  dlqTopic?: string;
  /** SASL 鉴权（可选，生产环境推荐） */
  sasl?: KafkaConfig['sasl'];
  /** SSL 配置（可选） */
  ssl?: KafkaConfig['ssl'];
  /** 连接超时 ms（默认 10000） */
  connectionTimeoutMs?: number;
  /** 请求超时 ms（默认 30000） */
  requestTimeoutMs?: number;
  /** 重试配置 */
  retry?: KafkaConfig['retry'];
}

export class KafkaMqProducer implements MqProducer {
  private kafka: Kafka;
  private producer: Producer;
  private topic: string;
  private dlqTopic: string;
  private connected = false;
  private connectPromise: Promise<void> | undefined;

  constructor(opts: KafkaProducerOptions) {
    this.kafka = new Kafka({
      clientId: opts.clientId,
      brokers: opts.brokers,
      sasl: opts.sasl,
      ssl: opts.ssl,
      connectionTimeout: opts.connectionTimeoutMs,
      requestTimeout: opts.requestTimeoutMs,
      retry: opts.retry,
    });
    this.producer = this.kafka.producer({
      // 允许消息乱序（提高吞吐；ingest 消息无严格顺序要求）
      allowAutoTopicCreation: false,
    });
    this.topic = opts.topic ?? TOPIC_INGEST;
    this.dlqTopic = opts.dlqTopic ?? TOPIC_DLQ;
  }

  /** 懒连接：首次 send 时建立连接，避免空载启动开销 */
  private async ensureConnected(): Promise<void> {
    if (this.connected) return;
    if (!this.connectPromise) {
      this.connectPromise = this.producer.connect().then(() => {
        this.connected = true;
      });
    }
    await this.connectPromise;
  }

  async send(value: string, opts?: MqProduceOptions): Promise<void> {
    await this.ensureConnected();
    await this.producer.send({
      topic: this.topic,
      messages: [
        {
          key: opts?.key,
          value,
          headers: opts?.headers,
        },
      ],
    });
  }

  async sendBatch(messages: Array<{ value: string; opts?: MqProduceOptions }>): Promise<void> {
    if (messages.length === 0) return;
    await this.ensureConnected();
    await this.producer.send({
      topic: this.topic,
      messages: messages.map((m) => ({
        key: m.opts?.key,
        value: m.value,
        headers: m.opts?.headers,
      })),
    });
  }

  async sendToDlq(originalValue: string, reason: string, opts?: MqProduceOptions): Promise<void> {
    await this.ensureConnected();
    const dlqPayload = encodeDlqMessage({
      original: originalValue,
      reason,
      attempts: 1, // 由调用方在多次重试后填充，此处默认 1
      failedAt: Date.now(),
    });
    await this.producer.send({
      topic: this.dlqTopic,
      messages: [
        {
          key: opts?.key,
          value: dlqPayload,
          headers: { ...opts?.headers, 'dlq-reason': reason.slice(0, 200) },
        },
      ],
    });
  }

  async close(): Promise<void> {
    if (!this.connected) return;
    try {
      await this.producer.disconnect();
    } finally {
      this.connected = false;
      this.connectPromise = undefined;
    }
  }
}
