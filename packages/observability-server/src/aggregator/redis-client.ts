/**
 * Redis 客户端封装（Phase 7）。
 *
 * 基于 ioredis，提供：
 * - 共享连接（collector / worker 多实例共用同一 Redis 集群）
 * - 滑动窗口清理（ZSET + ZREMRANGEBYSCORE）
 * - 批量 HINCRBY（计数器累加）
 * - Lua 脚本支持（直方图分位数计算，避免多次往返）
 *
 * Key 设计：
 * - `aipack:agg:{appId}:{dim}:{dimKey}:buckets`  ZSET  member=bucketIdx  score=bucketIdx（用于清理过期桶）
 * - `aipack:agg:{appId}:{dim}:{dimKey}:b:{bucketIdx}`  Hash  字段=计数器名  值=数值
 * - `aipack:agg:{appId}:tracever`  Hash  字段=traceId  值=version（trace→版本映射）
 *
 * TTL 策略：
 * - ZSET 不设 TTL（靠 ZREMRANGEBYSCORE 清理）
 * - Hash 桶设 TTL = windowMs * 2（兜底，避免 ZSET 清理失败导致僵尸桶）
 */

import Redis from 'ioredis';

export interface RedisClientOptions {
  /** Redis 连接串，如 redis://localhost:6379；集群用 redis://host1:6379,host2:6379 */
  url?: string;
  /** 已存在的 ioredis 实例（优先于 url，由调用方管理生命周期） */
  client?: Redis;
  /** Key 前缀（默认 aipack:agg:），多租户隔离用 */
  keyPrefix?: string;
  /** 连接超时 ms（默认 5000） */
  connectTimeoutMs?: number;
  /** 命令重试次数（默认 3） */
  maxRetriesPerRequest?: number;
  /** 是否启用 readyCheck（默认 true） */
  enableReadyCheck?: boolean;
}

export class RedisClient {
  private client: Redis;
  private ownsClient: boolean;
  private keyPrefix: string;

  constructor(opts: RedisClientOptions = {}) {
    this.keyPrefix = opts.keyPrefix ?? 'aipack:agg:';
    if (opts.client) {
      this.client = opts.client;
      this.ownsClient = false;
    } else {
      const url = opts.url ?? 'redis://localhost:6379';
      this.client = new Redis(url, {
        connectTimeout: opts.connectTimeoutMs ?? 5000,
        maxRetriesPerRequest: opts.maxRetriesPerRequest ?? 3,
        enableReadyCheck: opts.enableReadyCheck ?? true,
        lazyConnect: false,
      });
      this.ownsClient = true;
    }
  }

  /** 获取原生 ioredis 实例（高级用法，如订阅 pub/sub） */
  get raw(): Redis {
    return this.client;
  }

  /** Key 前缀（多租户隔离） */
  get prefix(): string {
    return this.keyPrefix;
  }

  /** 拼接完整 key */
  key(suffix: string): string {
    return `${this.keyPrefix}${suffix}`;
  }

  // ─── 基础命令封装（便于 mock + 统一错误处理） ─────────────────────

  async hincrby(key: string, field: string, increment: number): Promise<number> {
    return this.client.hincrby(key, field, increment);
  }

  async hincrbyFloat(key: string, field: string, increment: number): Promise<number> {
    const r = await this.client.hincrbyfloat(key, field, increment);
    return Number(r);
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    return this.client.hgetall(key);
  }

  async hset(key: string, field: string, value: string | number): Promise<number> {
    return this.client.hset(key, field, value);
  }

  async hget(key: string, field: string): Promise<string | null> {
    return this.client.hget(key, field);
  }

  async hdel(key: string, ...fields: string[]): Promise<number> {
    return this.client.hdel(key, ...fields);
  }

  async zadd(key: string, score: number, member: string): Promise<number> {
    return this.client.zadd(key, score, member);
  }

  async zremrangebyscore(key: string, min: number, max: number): Promise<number> {
    return this.client.zremrangebyscore(key, min, max);
  }

  async zrangebyscore(key: string, min: number | string, max: number | string): Promise<string[]> {
    return this.client.zrangebyscore(key, min as string, max as string);
  }

  /**
   * ZRANGEBYSCORE WITHSCORES：返回 member+score 对。
   * D6 修复：直方图 ZSET 的 score 才是延迟值，member 是采样 ID；
   * 此前读 member 转数字全是 NaN，导致 p50/p95/p99 = NaN。
   */
  async zrangebyscoreWithScores(
    key: string,
    min: number | string,
    max: number | string,
  ): Promise<Array<{ member: string; score: number }>> {
    const raw = await this.client.zrangebyscore(key, min as string, max as string, 'WITHSCORES');
    const out: Array<{ member: string; score: number }> = [];
    for (let i = 0; i + 1 < raw.length; i += 2) {
      out.push({ member: String(raw[i]), score: Number(raw[i + 1]) });
    }
    return out;
  }

  /** SCAN 遍历匹配 key（D7：替代 KEYS，不阻塞 Redis 主线程） */
  async scanKeys(pattern: string, count = 100): Promise<string[]> {
    const out: string[] = [];
    let cursor = '0';
    do {
      const [next, keys] = await this.client.scan(cursor, 'MATCH', pattern, 'COUNT', String(count));
      cursor = next;
      out.push(...keys);
    } while (cursor !== '0');
    return out;
  }

  async expire(key: string, seconds: number): Promise<number> {
    return this.client.expire(key, seconds);
  }

  async del(key: string): Promise<number> {
    return this.client.del(key);
  }

  async ping(): Promise<string> {
    return this.client.ping();
  }

  // ─── Pipeline / 事务（批量提交降低 RTT） ─────────────────────────

  pipeline() {
    return this.client.pipeline();
  }

  /** 执行 pipeline 并返回结果数组 */
  async execPipeline(p: ReturnType<RedisClient['pipeline']>): Promise<unknown[]> {
    const results = await p.exec();
    if (!results) return [];
    return results.map(([, v]) => v);
  }

  /** 关闭连接（仅当 ownsClient=true 时实际关闭） */
  async close(): Promise<void> {
    if (this.ownsClient) {
      await this.client.quit();
    }
  }
}
