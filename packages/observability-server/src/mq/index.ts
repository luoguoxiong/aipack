/**
 * MQ 模块统一出口 + 工厂函数。
 *
 * createMqProducer(opts) 根据配置返回 MqProducer 实例：
 * - 默认返回 NoopMqProducer（collector 走原同步落盘，兼容旧行为）
 * - MQ_ENABLED=true 时返回 KafkaMqProducer
 *
 * collector 通过此工厂获取 producer；worker 直接构造 KafkaMqConsumer（独立 bin）。
 */

import type { MqProducer, MqProduceOptions } from './types';
import { KafkaMqProducer, type KafkaProducerOptions } from './kafka-producer';
import { KafkaMqConsumer, type KafkaConsumerOptions } from './kafka-consumer';

export { KafkaMqProducer, KafkaMqConsumer };
export type { KafkaProducerOptions, KafkaConsumerOptions };
export * from './types';

export interface CreateMqProducerOptions {
  /** 是否启用 MQ（默认 false：返回 NoopMqProducer） */
  enabled?: boolean;
  /** Kafka brokers（enabled=true 时必填） */
  brokers?: string[];
  /** clientId */
  clientId?: string;
  /** 主 topic（默认 aipack.ingest） */
  topic?: string;
  /** DLQ topic（默认 aipack.ingest.dlq） */
  dlqTopic?: string;
  /** SASL 鉴权（可选） */
  sasl?: KafkaProducerOptions['sasl'];
  /** SSL 配置（可选） */
  ssl?: KafkaProducerOptions['ssl'];
}

/**
 * 创建 MQ Producer。
 *
 * - enabled=false（默认）：返回 NoopMqProducer，collector 走同步落盘
 * - enabled=true：返回 KafkaMqProducer，collector produce 后立即返回 200
 */
export function createMqProducer(opts: CreateMqProducerOptions): MqProducer {
  if (!opts.enabled) {
    return new NoopMqProducer();
  }
  if (!opts.brokers || opts.brokers.length === 0) {
    throw new Error('MQ_ENABLED=true 时必须配置 KAFKA_BROKERS');
  }
  return new KafkaMqProducer({
    brokers: opts.brokers,
    clientId: opts.clientId ?? 'aipack-collector',
    topic: opts.topic,
    dlqTopic: opts.dlqTopic,
    sasl: opts.sasl,
    ssl: opts.ssl,
  });
}

/**
 * NoopMqProducer — MQ 关闭时的占位实现。
 *
 * - send / sendBatch：no-op（collector 检测到 noop 时走同步落盘，不会调用此 producer）
 * - 提供 NoopMqProducer 是为了类型完整 + 测试时注入 mock
 */
export class NoopMqProducer implements MqProducer {
  async send(_value: string, _opts?: MqProduceOptions): Promise<void> {
    // no-op：MQ 关闭时 collector 不应调用此方法（走同步落盘分支）
  }
  async sendBatch(_messages: Array<{ value: string; opts?: MqProduceOptions }>): Promise<void> {
    // no-op
  }
  async sendToDlq(_originalValue: string, _reason: string, _opts?: MqProduceOptions): Promise<void> {
    // no-op
  }
  async close(): Promise<void> {
    // no-op
  }
}
