/**
 * Aggregator 模块统一出口 + 工厂函数（Phase 7）。
 *
 * createAggregatorFactory(opts) 返回 AggregatorFactory：
 * - backend='memory'（默认）：进程内 MemoryAggregator（单实例可用，零依赖）
 * - backend='redis'：纯 Redis 聚合（多实例共享，但每次查询都打 Redis）
 * - backend='hybrid'（推荐）：L1 本地 + L2 Redis（兼顾性能与一致性）
 *
 * collector / worker 通过此工厂获取 aggregatorFor(appId) 函数。
 */

import { Aggregator as MemoryAggregator } from '../aggregator';
import { RedisClient } from './redis-client';
import { RedisAggregator } from './redis-aggregator';
import { HybridAggregator } from './hybrid-aggregator';
import type { Aggregator, AggregatorFactory, AggregatorConfig } from './interface';

export { MemoryAggregator, RedisClient, RedisAggregator, HybridAggregator };
export type { Aggregator, AggregatorFactory, AggregatorConfig } from './interface';

export interface CreateAggregatorFactoryOptions extends AggregatorConfig {
  /** 后端类型：'memory'（默认）/ 'redis' / 'hybrid' */
  backend?: 'memory' | 'redis' | 'hybrid';
  /** Redis 连接串（backend=redis|hybrid 时必填） */
  redisUrl?: string;
  /** 已存在的 RedisClient（优先于 redisUrl，由调用方管理生命周期） */
  redisClient?: RedisClient;
  /** Key 前缀（默认 aipack:agg:） */
  redisKeyPrefix?: string;
  /** L1 微窗口长度 ms（hybrid 模式默认 60000=1min） */
  l1WindowMs?: number;
  /** L2 主窗口长度 ms（redis/hybrid 模式默认 3600000=60min） */
  l2WindowMs?: number;
}

export interface AggregatorFactoryHandle {
  /** 按 appId 获取 Aggregator 实例 */
  aggregatorFor: AggregatorFactory;
  /** 关闭所有 aggregator（释放 Redis 连接等） */
  close: () => Promise<void>;
}

/**
 * 创建 Aggregator 工厂。
 *
 * - memory：每个 appId 一个 MemoryAggregator，全局用 'global'
 * - redis/hybrid：共享一个 RedisClient，每个 appId 一个 RedisAggregator（+ MemoryAggregator for hybrid L1）
 *
 * aggregatorFor(appId) 首次调用时创建实例并缓存，后续复用。
 */
export function createAggregatorFactory(
  opts: CreateAggregatorFactoryOptions,
): AggregatorFactoryHandle {
  const backend = opts.backend ?? 'memory';
  const windowMs = opts.windowMs ?? 60 * 60 * 1000;
  const bucketMs = opts.bucketMs ?? 60 * 1000;

  if (backend === 'memory') {
    const instances = new Map<string, MemoryAggregator>();
    return {
      aggregatorFor: (appId?: string) => {
        const key = appId ?? 'global';
        let agg = instances.get(key);
        if (!agg) {
          agg = new MemoryAggregator({ windowMs, bucketMs });
          instances.set(key, agg);
        }
        return agg;
      },
      close: async () => {
        await Promise.all([...instances.values()].map((a) => a.close()));
        instances.clear();
      },
    };
  }

  // redis / hybrid：共享 RedisClient
  let redisClient: RedisClient;
  let ownsRedis = false;
  if (opts.redisClient) {
    redisClient = opts.redisClient;
  } else {
    if (!opts.redisUrl) {
      throw new Error(`AGGREGATOR=${backend} 时必须配置 REDIS_URL 或传入 redisClient`);
    }
    redisClient = new RedisClient({ url: opts.redisUrl, keyPrefix: opts.redisKeyPrefix });
    ownsRedis = true;
  }

  const l2WindowMs = opts.l2WindowMs ?? windowMs;
  const l1WindowMs = opts.l1WindowMs ?? 60 * 1000; // hybrid L1 默认 1min

  const redisInstances = new Map<string, RedisAggregator>();
  const l1Instances = new Map<string, MemoryAggregator>();

  const getRedisAggregator = (appId: string): RedisAggregator => {
    let agg = redisInstances.get(appId);
    if (!agg) {
      agg = new RedisAggregator({
        redis: redisClient,
        appId,
        windowMs: l2WindowMs,
        bucketMs,
      });
      redisInstances.set(appId, agg);
    }
    return agg;
  };

  const getL1Aggregator = (appId: string): MemoryAggregator => {
    let agg = l1Instances.get(appId);
    if (!agg) {
      agg = new MemoryAggregator({ windowMs: l1WindowMs, bucketMs });
      l1Instances.set(appId, agg);
    }
    return agg;
  };

  if (backend === 'redis') {
    return {
      aggregatorFor: (appId?: string) => {
        const key = appId ?? 'global';
        return getRedisAggregator(key);
      },
      close: async () => {
        await Promise.all([...redisInstances.values()].map((a) => a.close()));
        redisInstances.clear();
        if (ownsRedis) await redisClient.close();
      },
    };
  }

  // hybrid
  const hybridInstances = new Map<string, HybridAggregator>();
  return {
    aggregatorFor: (appId?: string) => {
      const key = appId ?? 'global';
      let agg = hybridInstances.get(key);
      if (!agg) {
        agg = new HybridAggregator({
          l1: getL1Aggregator(key),
          l2: getRedisAggregator(key),
        });
        hybridInstances.set(key, agg);
      }
      return agg;
    },
    close: async () => {
      await Promise.all([...hybridInstances.values()].map((a) => a.close()));
      hybridInstances.clear();
      l1Instances.clear();
      redisInstances.clear();
      if (ownsRedis) await redisClient.close();
    },
  };
}
