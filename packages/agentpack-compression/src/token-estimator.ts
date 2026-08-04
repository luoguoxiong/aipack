/**
 * Token 估算器 - 轻量字符启发式，零依赖
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

// ─── 字符启发式实现 ───────────────────────────────────────────────

export class CharHeuristicEstimator implements TokenEstimator {
  private cache = new Map<string, number>();

  constructor(
    private charsPerTokenAscii = 4,
    private charsPerTokenCJK = 1.5,
  ) {}

  estimate(resource: ContextResource): number {
    if (this.cache.has(resource.id)) return this.cache.get(resource.id)!;

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
): TokenEstimator {
  return new CharHeuristicEstimator(charsPerTokenAscii, charsPerTokenCJK);
}
