/**
 * Token 估算器 - 轻量字符启发式，零依赖
 *
 * 缓存带 LRU 上限，避免长会话下缓存无限膨胀。
 */

import type { ContextResource } from 'agentpack';
import { extractTextFromResource } from 'agentpack';

// ─── 接口 ─────────────────────────────────────────────────────────

export interface TokenEstimator {
  estimate(resource: ContextResource): number;
  estimateAll(resources: ContextResource[]): number;
  /** 使缓存失效（内容变更后调用） */
  invalidate(resourceId?: string): void;
}

// ─── LRU 缓存 ─────────────────────────────────────────────────────

class LruCache<K, V> {
  private map = new Map<K, V>();
  constructor(private capacity: number) {}

  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined;
    // 重新插入以刷新顺序
    const value = this.map.get(key)!;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    else if (this.map.size >= this.capacity) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey !== undefined) this.map.delete(oldestKey);
    }
    this.map.set(key, value);
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}

// ─── 字符启发式实现 ───────────────────────────────────────────────

export class CharHeuristicEstimator implements TokenEstimator {
  private cache: LruCache<string, number>;

  constructor(
    private charsPerTokenAscii = 4,
    private charsPerTokenCJK = 1.5,
    cacheCapacity = 1000,
  ) {
    this.cache = new LruCache<string, number>(Math.max(1, cacheCapacity));
  }

  estimate(resource: ContextResource): number {
    const cached = this.cache.get(resource.id);
    if (cached !== undefined) return cached;

    const text = extractTextFromResource(resource);
    let asciiChars = 0;
    let cjkChars = 0;

    for (const ch of text) {
      if (ch.charCodeAt(0) > 0x2e80) cjkChars++;
      else asciiChars++;
    }

    const textTokens = Math.ceil(asciiChars / this.charsPerTokenAscii)
                      + Math.ceil(cjkChars / this.charsPerTokenCJK);

    // 图片 token 估算
    let imageTokens = 0;
    try {
      const contentStr = typeof resource.content === 'string'
        ? resource.content
        : JSON.stringify(resource.content);
      if (contentStr.includes('"type":"image"') || contentStr.includes('"type": "image"')) {
        imageTokens = 1500;
      }
    } catch {
      // ignore
    }

    const total = textTokens + imageTokens;
    this.cache.set(resource.id, total);
    return total;
  }

  estimateAll(resources: ContextResource[]): number {
    return resources.reduce((sum, r) => sum + this.estimate(r), 0);
  }

  invalidate(resourceId?: string): void {
    if (resourceId) {
      this.cache.delete(resourceId);
    } else {
      this.cache.clear();
    }
  }
}

/** 工厂函数 */
export function createTokenEstimator(
  charsPerTokenAscii = 4,
  charsPerTokenCJK = 1.5,
  cacheCapacity = 1000,
): TokenEstimator {
  return new CharHeuristicEstimator(charsPerTokenAscii, charsPerTokenCJK, cacheCapacity);
}
