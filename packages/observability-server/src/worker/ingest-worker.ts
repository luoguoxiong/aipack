/**
 * ingest-worker — 独立消费 worker（bin: observability-worker）。
 *
 *   职责：消费 Kafka topic `aipack.ingest` → TraceStore.flush（CH 批量写入）
 *
 *   启动：observability-worker（需先 build）
 *         或：pnpm --filter @aipack-ai/observability-server worker（tsx 开发模式）
 *
 *   配置（环境变量，与 collector 共用 .env）：
 *     - KAFKA_BROKERS         必填
 *     - KAFKA_GROUP_ID        默认 obs-workers
 *     - KAFKA_TOPIC           默认 aipack.ingest
 *     - KAFKA_DLQ_TOPIC       默认 aipack.ingest.dlq
 *     - KAFKA_CONSUMER_BATCH  单批最大消息数（默认 500）
 *     - KAFKA_CONSUMER_WAIT   攒批超时 ms（默认 1000）
 *     - KAFKA_FROM_BEGINNING  是否从最早 offset 消费（默认 false）
 *     - KAFKA_MAX_RETRIES     失败重试上限（默认 3，超过进 DLQ）
 *     - TRACE_STORE           监控库后端（worker 端必须 clickhouse，不接受 sqlite）
 *     - CLICKHOUSE_URL        CH 端点
 *     - CLICKHOUSE_DB / USER / PASSWORD
 *
 *   错误处理：
 *     - 单条消息解析失败 → 直接进 DLQ（不重试，避免毒丸阻塞整批）
 *     - flush 失败 → 整批重试，达上限后整批进 DLQ
 *     - DLQ 速率超阈值 → 日志告警（Phase 3 简化版，Phase 7 接 alerts/evaluator）
 *
 *   横向扩展：
 *     - 多实例同 KAFKA_GROUP_ID，Kafka 自动 rebalance 分配 partition
 *     - 单实例吞吐：单 partition 顺序消费，批量 INSERT CH（约 5k msg/s）
 */

import { createRequire } from 'node:module';
import { loadConfig } from '../config.js';
import type { CollectorConfig } from '../config.js';
import { createTraceStore } from '../stores/index.js';
import type { TraceStore } from '../stores/index.js';
import { KafkaMqProducer } from '../mq/kafka-producer.js';
import { KafkaMqConsumer } from '../mq/kafka-consumer.js';
import type { MqMessage, IngestMessage } from '../mq/types.js';
import { decodeIngestMessage } from '../mq/types.js';
import { sendToDlq, DlqMonitor } from './dlq.js';
import type { SASLOptions } from 'kafkajs';
import { createAggregatorFactory } from '../aggregator/index.js';
import type { AggregatorFactory } from '../aggregator/interface.js';
// Phase 6 — Cost 计算
import type Database from 'better-sqlite3';
import { SQLiteModelPriceStore, MySQLModelPriceStore } from '../stores/model-price-store.js';
import type { ModelPriceStore } from '../stores/model-price-store.js';
import { MysqlPool } from '../stores/mysql.js';
import { createCostCalculator } from '../cost/calculator.js';
import type { CostCalculator } from '../cost/calculator.js';

// ESM（本包 type: module）下无全局 require，用 createRequire 兼容原 require('better-sqlite3') 的懒加载写法
const require = createRequire(import.meta.url);

interface WorkerConfig {
  brokers: string[];
  groupId: string;
  topic: string;
  dlqTopic: string;
  batchSize: number;
  batchWaitMs: number;
  fromBeginning: boolean;
  maxRetries: number;
  clientId: string;
  sasl?: SASLOptions;
  ssl: boolean;
}

function readWorkerConfig(): WorkerConfig {
  const cfg = loadConfig();
  if (!cfg.mq.enabled) {
    throw new Error('MQ_ENABLED=false，worker 无需启动（collector 走同步落盘）');
  }
  if (cfg.traceStore.backend === 'sqlite') {
    throw new Error('TRACE_STORE=sqlite 时 worker 无意义（Kafka 解耦的目标是 CH），请配置 TRACE_STORE=clickhouse');
  }
  const batchSize = Number(process.env.KAFKA_CONSUMER_BATCH) || 500;
  const batchWaitMs = Number(process.env.KAFKA_CONSUMER_WAIT) || 1000;
  const fromBeginning = (process.env.KAFKA_FROM_BEGINNING ?? 'false').toLowerCase() === 'true';
  const maxRetries = Number(process.env.KAFKA_MAX_RETRIES) || 3;
  return {
    brokers: cfg.mq.brokers,
    groupId: cfg.mq.groupId,
    topic: cfg.mq.topic,
    dlqTopic: cfg.mq.dlqTopic,
    batchSize,
    batchWaitMs,
    fromBeginning,
    maxRetries,
    clientId: cfg.mq.clientId + '-worker',
    sasl: cfg.mq.sasl as never,
    ssl: cfg.mq.ssl,
  };
}

/**
 * Phase 6 — 根据 config 创建 ModelPriceStore（SQLite / MySQL）。
 * 返回 store + close 句柄（worker 退出时关闭连接）。
 */
function createModelPriceStoreHandle(
  cfg: CollectorConfig,
): { store: ModelPriceStore; close: () => Promise<void> } {
  if (cfg.businessStore.backend === 'mysql') {
    if (!cfg.businessStore.mysqlUrl) {
      throw new Error('BUSINESS_STORE=mysql 时必须配置 MYSQL_URL');
    }
    const pool = new MysqlPool(cfg.businessStore.mysqlUrl);
    return {
      store: new MySQLModelPriceStore(pool),
      close: async () => {
        await pool.close();
      },
    };
  }
  // SQLite（零依赖默认）
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3');
  const db: Database.Database = new Database(cfg.dbPath);
  db.pragma('journal_mode = WAL');
  return {
    store: new SQLiteModelPriceStore(db),
    close: async () => {
      db.close();
    },
  };
}

/**
 * Phase 6 — flush 前计算 model span 成本：
 * - 预热价格缓存 → 逐 span 调 calculator.calculate 得 costCents
 * - 写入 span.costCents
 * - 按 traceId 累加到对应 run 的 costCents 字段
 */
async function applyCost(batch: IngestMessage['batch'], calculator: CostCalculator): Promise<void> {
  const modelSpans = batch.spans.filter((s) => s.kind === 'model');
  if (modelSpans.length === 0) return;
  // 预热价格缓存（一次并发查 DB，避免逐 span 打库）
  const modelIds = [...new Set(modelSpans.map((s) => s.name.replace(/^model:/, '')))];
  await calculator.preloadPrices(modelIds);
  // 计算 cost 并按 traceId 汇总
  const costByTrace = new Map<string, number>();
  for (const s of modelSpans) {
    const modelId = s.name.replace(/^model:/, '');
    const costCents = calculator.calculate({
      modelId,
      inputTokens: s.inputTokens ?? 0,
      outputTokens: s.outputTokens ?? 0,
      cacheRead: s.cacheRead,
      cacheWrite: s.cacheWrite,
    });
    s.costCents = costCents;
    costByTrace.set(s.traceId, (costByTrace.get(s.traceId) ?? 0) + costCents);
  }
  // 将累加 cost 写入对应 run 的 costCents 字段
  for (const r of batch.runs) {
    const c = costByTrace.get(r.traceId);
    if (c !== undefined) r.costCents = (r.costCents ?? 0) + c;
  }
}

async function main(): Promise<void> {
  const cfg = readWorkerConfig();
  console.log('[ingest-worker] 启动中...', {
    brokers: cfg.brokers,
    topic: cfg.topic,
    groupId: cfg.groupId,
    batchSize: cfg.batchSize,
    batchWaitMs: cfg.batchWaitMs,
  });

  // 创建 TraceStore（worker 端只支持 CH）
  const tsConfig = loadConfig();
  const ts = await createTraceStore({
    traceStore: tsConfig.traceStore.backend,
    sqliteDbPath: tsConfig.dbPath,
    clickhouseUrl: tsConfig.traceStore.clickhouseUrl,
    clickhouseDatabase: tsConfig.traceStore.clickhouseDatabase,
    clickhouseUsername: tsConfig.traceStore.clickhouseUsername,
    clickhousePassword: tsConfig.traceStore.clickhousePassword,
  });
  const traceStore: TraceStore = ts.traceStore;
  console.log(`[ingest-worker] 监控库: ${tsConfig.traceStore.backend}`);

  // 创建 Aggregator 工厂（Phase 7）：worker 消费后喂聚合器，保证 Redis/Hybrid 模式下数据完整
  const aggHandle = createAggregatorFactory({
    backend: tsConfig.aggregator.backend,
    redisUrl: tsConfig.aggregator.redisUrl,
    redisKeyPrefix: tsConfig.aggregator.redisKeyPrefix,
    l1WindowMs: tsConfig.aggregator.l1WindowMs,
    l2WindowMs: tsConfig.aggregator.l2WindowMs,
  });
  const aggregatorFor: AggregatorFactory = aggHandle.aggregatorFor;
  if (tsConfig.aggregator.backend !== 'memory') {
    console.log(`[ingest-worker] 聚合: ${tsConfig.aggregator.backend}（redis=${tsConfig.aggregator.redisUrl}）`);
  } else {
    console.log('[ingest-worker] 聚合: memory（单实例）');
  }

  // Phase 6 — 创建 ModelPriceStore + CostCalculator（flush 前计算 model span 成本）
  const priceStoreHandle = createModelPriceStoreHandle(tsConfig);
  const costCalculator: CostCalculator = createCostCalculator(priceStoreHandle.store);
  console.log(`[ingest-worker] 价格库: ${tsConfig.businessStore.backend}`);

  // 创建 DLQ producer（worker 端独立 producer，与 collector 解耦）
  const dlqProducer = new KafkaMqProducer({
    brokers: cfg.brokers,
    clientId: cfg.clientId + '-dlq',
    topic: cfg.topic,
    dlqTopic: cfg.dlqTopic,
    sasl: cfg.sasl as never,
    ssl: cfg.ssl,
  });

  // DLQ 速率监控（窗口 60s，超 10 条告警）
  const dlqMonitor = new DlqMonitor({
    threshold: 10,
    intervalMs: 60_000,
    onAlert: (count, windowMs) => {
      console.error(
        `[ingest-worker][ALERT] DLQ 速率告警：${count} 条/(${windowMs}ms)，请检查 TraceStore 可用性`,
      );
    },
  });
  dlqMonitor.start();

  // 创建 consumer
  const consumer = new KafkaMqConsumer({
    brokers: cfg.brokers,
    clientId: cfg.clientId,
    groupId: cfg.groupId,
    maxBatchSize: cfg.batchSize,
    maxBatchMs: cfg.batchWaitMs,
    fromBeginning: cfg.fromBeginning,
    sasl: cfg.sasl as never,
    ssl: cfg.ssl,
  });

  // 统计指标
  let processed = 0;
  let failed = 0;
  let lastLog = Date.now();

  await consumer.subscribe(cfg.topic, async (messages: MqMessage[]) => {
    // 单批处理：解析 → flush；失败重试 maxRetries 次 → 进 DLQ
    const valid: Array<{ msg: IngestMessage; raw: MqMessage }> = [];
    const invalid: MqMessage[] = [];

    // 阶段 1：解析（单条解析失败直接进 DLQ，避免毒丸阻塞整批）
    for (const raw of messages) {
      try {
        const msg = decodeIngestMessage(raw.value);
        valid.push({ msg, raw });
      } catch (err) {
        invalid.push(raw);
        await sendToDlq(dlqProducer, {
          originalValue: raw.value,
          reason: `解析失败: ${(err as Error).message}`,
          attempts: 1,
          key: raw.key,
        }).catch((e) => console.error('[ingest-worker] DLQ 发送失败:', e));
        dlqMonitor.record();
        failed++;
      }
    }

    if (valid.length === 0) {
      // 全部解析失败，已逐条进 DLQ，直接返回（commit offset）
      return;
    }

    // 阶段 2：合并 batch flush（同 appId 合并，减少 CH INSERT 次数）
    // 简化：按 appId 分组，每组调一次 flush
    const byApp = new Map<string, IngestMessage[]>();
    for (const { msg } of valid) {
      const arr = byApp.get(msg.appId) ?? [];
      arr.push(msg);
      byApp.set(msg.appId, arr);
    }

    // 重试逻辑：整批失败才重试；部分失败按 appId 隔离
    for (const [appId, msgs] of byApp) {
      // 合并 EventBatch
      const mergedBatch = msgs.reduce((acc, m) => {
        acc.runs.push(...m.batch.runs);
        acc.spans.push(...m.batch.spans);
        acc.toolCalls.push(...m.batch.toolCalls);
        acc.permissions.push(...m.batch.permissions);
        acc.retries.push(...m.batch.retries);
        acc.events.push(...m.batch.events);
        return acc;
      }, {
        runs: [],
        spans: [],
        toolCalls: [],
        permissions: [],
        retries: [],
        events: [],
      } as IngestMessage['batch']);

      // Phase 6 — flush 前计算 model span 成本，写入 span.costCents 并累加到 run.costCents
      await applyCost(mergedBatch, costCalculator);

      let attempt = 0;
      let success = false;
      let lastErr: Error | undefined;
      while (attempt < cfg.maxRetries) {
        attempt++;
        try {
          await traceStore.flush(mergedBatch, appId);
          success = true;
          break;
        } catch (err) {
          lastErr = err as Error;
          console.warn(`[ingest-worker] flush 失败 (attempt ${attempt}/${cfg.maxRetries}, appId=${appId}):`, (err as Error).message);
          // 指数退避：100ms, 200ms, 400ms...
          await new Promise((r) => setTimeout(r, 100 * Math.pow(2, attempt - 1)));
        }
      }

      if (success) {
        // Phase 7：flush 成功后喂聚合器（与 collector 行为一致）
        // 注意：MQ 模式下 collector 不再喂聚合器（仅 produce Kafka），由 worker 统一喂
        const global = aggregatorFor();
        const appAgg = aggregatorFor(appId);
        for (const r of mergedBatch.runs) {
          global.ingestRun(r);
          appAgg.ingestRun(r);
        }
        for (const s of mergedBatch.spans) {
          global.ingestModelCall(s);
          appAgg.ingestModelCall(s);
        }
        for (const t of mergedBatch.toolCalls) {
          global.ingestToolCall(t);
          appAgg.ingestToolCall(t);
        }
        for (const p of mergedBatch.permissions) {
          global.ingestPermission(p);
          appAgg.ingestPermission(p);
        }
        for (const rt of mergedBatch.retries) {
          global.ingestRetry(rt);
          appAgg.ingestRetry(rt);
        }
      }

      if (!success && lastErr) {
        // 重试达上限 → 整批进 DLQ
        for (const m of msgs) {
          const raw = valid.find((v) => v.msg === m)?.raw;
          await sendToDlq(dlqProducer, {
            originalValue: raw?.value ?? JSON.stringify(m),
            reason: `flush 重试 ${cfg.maxRetries} 次失败: ${lastErr.message}`,
            attempts: cfg.maxRetries,
            key: raw?.key ?? appId,
          }).catch((e) => console.error('[ingest-worker] DLQ 发送失败:', e));
          dlqMonitor.record();
          failed++;
        }
      } else {
        processed += msgs.length;
      }
    }

    // 周期日志（每 30s 打一次）
    const now = Date.now();
    if (now - lastLog > 30_000) {
      console.log(`[ingest-worker] 处理 ${processed} 条，失败 ${failed} 条，DLQ 计数 ${dlqMonitor.currentCount()}`);
      lastLog = now;
    }
  });

  console.log('[ingest-worker] 已启动，等待消息...');

  // 优雅退出
  const shutdown = async (sig: string) => {
    console.log(`\n[${sig}] worker 正在关闭...`);
    dlqMonitor.stop();
    await consumer.close();
    await dlqProducer.close();
    await ts.close();
    await priceStoreHandle.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[ingest-worker] 启动失败:', err);
  process.exit(1);
});
