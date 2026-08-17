/**
 * MQ 抽象接口（Phase 3）。
 *
 * 设计原则：与具体 MQ 实现解耦（Kafka / Redpanda / NATS JetStream 可互换）。
 * - collector 通过 `MqProducer` 把 ingest 批量 produce 到 MQ（不落本地）
 * - ingest-worker 通过 `MqConsumer` 批量消费 → TraceStore.flush + Aggregator
 * - 失败消息走 DLQ topic（`MqProducer.sendToDlq`）
 *
 * 消息格式：
 * - key:   appId（保证同应用消息进同一 partition，便于按应用聚合）
 * - value: JSON 序列化的 EventBatch + appId 元信息（IngestMessage）
 *
 * 当前实现：kafkajs（src/mq/kafka-producer.ts / kafka-consumer.ts）
 */

import type { EventBatch } from '@aipack-ai/observability';

/**
 * MQ 消息体：collector 写入 → worker 消费的负载。
 *
 * 与 SDK 的 EventBatch 区别：
 * - 多了 appId（鉴权后盖戳，worker 不再二次鉴权）
 * - 多了 ingestedAt（用于 worker 端计算端到端延迟）
 */
export interface IngestMessage {
  /** 应用 ID（collector 鉴权后写入） */
  appId: string;
  /** 上报批次（SDK 原始 EventBatch） */
  batch: EventBatch;
  /** collector 收到时间戳（ms），用于端到端延迟统计 */
  ingestedAt: number;
}

/** MQ 单条消息（producer 端发送 / consumer 端接收） */
export interface MqMessage {
  /** topic 名 */
  topic: string;
  /** 分区号（consumer 接收时填充） */
  partition?: number;
  /** offset（consumer 接收时填充） */
  offset?: string;
  /** 消息 key（producer 端设置，用于分区路由） */
  key?: string;
  /** 消息 value（producer 端为 string/buffer，consumer 端为 string） */
  value: string;
  /** 时间戳（ms） */
  timestamp?: string;
}

/** Producer 发送选项 */
export interface MqProduceOptions {
  /** 消息 key（同 key 进同 partition；不设置则轮询） */
  key?: string;
  /** 消息 headers（用于追踪/标记） */
  headers?: Record<string, string>;
}

/**
 * MQ Producer 接口。
 *
 * - `send`：发送单条消息到主 topic（aipack.ingest）
 * - `sendBatch`：批量发送（collector 单次 ingest 可合并多消息）
 * - `sendToDlq`：发送到死信队列（worker 处理失败时用）
 * - `close`：优雅关闭（等待 in-flight 消息发完）
 */
export interface MqProducer {
  /** 发送单条消息 */
  send(value: string, opts?: MqProduceOptions): Promise<void>;
  /** 批量发送（同 topic，提高吞吐） */
  sendBatch(messages: Array<{ value: string; opts?: MqProduceOptions }>): Promise<void>;
  /** 发送到死信队列（附带失败原因） */
  sendToDlq(originalValue: string, reason: string, opts?: MqProduceOptions): Promise<void>;
  /** 关闭 producer */
  close(): Promise<void>;
}

/** Consumer 批量拉取回调签名 */
export type MqConsumeHandler = (messages: MqMessage[]) => Promise<void>;

/**
 * MQ Consumer 接口。
 *
 * - `subscribe`：订阅 topic 并注册 handler（启动后持续拉取）
 * - `stop`：停止消费（不关闭连接，可重启）
 * - `close`：关闭连接
 *
 * 批量语义：consumer 内部按 `maxBatchSize` / `maxBatchMs` 攒批，
 * 攒满或超时后调用 handler。handler 抛错 → 消息进 DLQ，offset 不提交；
 * handler 成功 → 批量提交 offset。
 */
export interface MqConsumer {
  /** 订阅 topic + 注册批量 handler */
  subscribe(topic: string, handler: MqConsumeHandler): Promise<void>;
  /** 停止消费（保留连接，可重新 subscribe） */
  stop(): Promise<void>;
  /** 关闭连接 */
  close(): Promise<void>;
}

/** Consumer 批量拉取配置 */
export interface MqConsumerOptions {
  /** consumer group id（同一 group 内消息均分） */
  groupId: string;
  /** 单批最大消息数（默认 500） */
  maxBatchSize?: number;
  /** 攒批超时 ms（默认 1000，超时即使不满 maxBatchSize 也触发 handler） */
  maxBatchMs?: number;
  /** 是否从最早 offset 开始消费（默认 false：只消费新消息） */
  fromBeginning?: boolean;
}

// ─── 默认 topic 常量 ────────────────────────────────────────────────

export const TOPIC_INGEST = 'aipack.ingest';
export const TOPIC_DLQ = 'aipack.ingest.dlq';

/** IngestMessage 序列化（producer 端用） */
export function encodeIngestMessage(msg: IngestMessage): string {
  return JSON.stringify(msg);
}

/** IngestMessage 反序列化（consumer 端用） */
export function decodeIngestMessage(value: string): IngestMessage {
  return JSON.parse(value) as IngestMessage;
}

/** DLQ 消息体（worker 处理失败时构造） */
export interface DlqMessage {
  /** 原始消息 value（IngestMessage JSON） */
  original: string;
  /** 失败原因（错误 message） */
  reason: string;
  /** 失败次数（重试达上限后进 DLQ） */
  attempts: number;
  /** 进 DLQ 时间戳（ms） */
  failedAt: number;
}

export function encodeDlqMessage(msg: DlqMessage): string {
  return JSON.stringify(msg);
}

export function decodeDlqMessage(value: string): DlqMessage {
  return JSON.parse(value) as DlqMessage;
}
