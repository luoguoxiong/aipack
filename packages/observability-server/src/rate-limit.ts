/**
 * Ingest 限流（P1-3 传输安全）：per-appId 令牌桶。
 *
 * 防止单个 app 用大量小请求刷爆 MAX_BODY 并发上限。
 * 默认 INGEST_RATE=100/s、INGEST_BURST=200（宽松，误伤概率低）；
 * 超限返回 429 + Retry-After，客户端 HttpReporter 对 429 走缓存补报。
 */

export interface RateLimitOptions {
  /** 令牌补充速率（个/秒） */
  rate: number;
  /** 桶容量（突发上限） */
  burst: number;
}

/** 令牌桶：capacity 容量，refillPerSec 每秒补充速率 */
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(private readonly capacity: number, private readonly refillPerSec: number) {
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  /** 取 1 个令牌；不足返回 false */
  take(): boolean {
    const now = Date.now();
    const elapsedSec = (now - this.lastRefill) / 1000;
    this.lastRefill = now;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillPerSec);
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}

/**
 * per-key 令牌桶限流器。
 * 稀疏 key 会无限增长 → 定期清理空闲桶（30min 未活动删除）。
 */
export class RateLimiter {
  private buckets = new Map<string, { bucket: TokenBucket; lastActive: number }>();
  private readonly idleMs = 30 * 60 * 1000;
  private lastSweep = Date.now();

  constructor(private opts: RateLimitOptions) {}

  /** 检查并消耗 1 个令牌；超限返回 false */
  check(key: string): boolean {
    const now = Date.now();
    let entry = this.buckets.get(key);
    if (!entry) {
      entry = { bucket: new TokenBucket(this.opts.burst, this.opts.rate), lastActive: now };
      this.buckets.set(key, entry);
    }
    entry.lastActive = now;
    const ok = entry.bucket.take();
    if (now - this.lastSweep > this.idleMs) this.sweep(now);
    return ok;
  }

  private sweep(now: number): void {
    this.lastSweep = now;
    for (const [key, entry] of this.buckets) {
      if (now - entry.lastActive > this.idleMs) this.buckets.delete(key);
    }
  }
}
