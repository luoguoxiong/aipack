/**
 * Redis 分布式令牌桶限流（Phase 3）。
 *
 * 替代进程内 TokenBucket（src/rate-limit.ts），用 Redis + Lua 脚本保证
 * 多实例（collector / worker）下的原子性与一致性。
 *
 * 设计：
 * - 每个 key 一个 Redis Hash，存 tokens（当前令牌数，float）与 lastRefill（上次补充时间 ms）
 * - Lua 脚本：读取当前令牌 → 按 elapsed 补充 → 扣减 → 写回 → 返回是否成功
 *   （单次 RTT 内原子完成，避免 check-then-act 竞态）
 * - 空闲 TTL：30min 未活动自动清理（与进程内 RateLimiter.sweep 策略对齐）
 *
 * 接口与 src/rate-limit.ts 的 TokenBucket.take() 对齐：返回 boolean（是否允许）。
 */

import type { RedisClient } from './aggregator/redis-client.js';

export interface RedisRateLimiterOptions {
  /** 共享的 Redis 客户端（多实例共用同一 Redis 集群） */
  redis: RedisClient;
  /** 令牌补充速率（个/秒） */
  rate: number;
  /** 桶容量（突发上限） */
  burst: number;
}

/**
 * Lua 脚本：原子地"补充 + 扣减"。
 *
 * KEYS[1] = 限流 key（Hash，字段：tokens / lastRefill）
 * ARGV[1] = capacity（桶容量）
 * ARGV[2] = refillPerSec（每秒补充速率）
 * ARGV[3] = now（epoch ms）
 * ARGV[4] = ttl（秒，空闲清理）
 *
 * 返回 1（允许）或 0（拒绝）。
 */
const TAKE_LUA = `
local capacity = tonumber(ARGV[1])
local refillPerSec = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])

local tokens = tonumber(redis.call('HGET', KEYS[1], 'tokens'))
local lastRefill = tonumber(redis.call('HGET', KEYS[1], 'lastRefill'))

if tokens == nil then
  -- 首次访问：满桶
  tokens = capacity
  lastRefill = now
end

-- 按 elapsed 补充（时钟回拨保护：elapsed < 0 时按 0 处理）
local elapsedSec = (now - lastRefill) / 1000
if elapsedSec < 0 then elapsedSec = 0 end
tokens = math.min(capacity, tokens + elapsedSec * refillPerSec)

local allowed = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
end

-- 写回（%.6f 避免科学计数法导致 tonumber 解析失败）
redis.call('HSET', KEYS[1], 'tokens', string.format('%.6f', tokens), 'lastRefill', string.format('%d', now))
redis.call('EXPIRE', KEYS[1], ttl)

return allowed
`;

/** 空闲 key TTL（秒）：30min 未活动自动清理，避免稀疏 key 无限增长 */
const IDLE_TTL_SEC = 30 * 60;

export class RedisRateLimiter {
  private redis: RedisClient;
  private readonly rate: number;
  private readonly burst: number;
  private readonly keyPrefix: string;

  constructor(opts: RedisRateLimiterOptions) {
    this.redis = opts.redis;
    this.rate = opts.rate;
    this.burst = opts.burst;
    // 复用 RedisClient 的 keyPrefix（多租户隔离），限流 key 单独子命名空间避免冲突
    this.keyPrefix = `${opts.redis.prefix}rl:`;
  }

  /**
   * 取 1 个令牌；允许返回 true，超限返回 false。
   * 单次 Lua 脚本调用，原子完成"补充 → 扣减 → 写回"。
   */
  async take(key: string): Promise<boolean> {
    const fullKey = this.keyPrefix + key;
    const now = Date.now();
    const allowed = await this.redis.raw.eval(
      TAKE_LUA,
      1,
      fullKey,
      this.burst,
      this.rate,
      now,
      IDLE_TTL_SEC,
    );
    return Number(allowed) === 1;
  }
}

/** 工厂：创建 RedisRateLimiter */
export function createRedisRateLimiter(opts: RedisRateLimiterOptions): RedisRateLimiter {
  return new RedisRateLimiter(opts);
}
