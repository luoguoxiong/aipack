/**
 * Semantic Analyzer — P3 语义循环检测
 * 使用 SimHash + n-gram 检测文本输出的语义重复
 */

import type { TraceStep, DetectionResult } from './types';

/**
 * SimHash: 将文本映射为一个固定位数的指纹
 * 相似文本的 SimHash 海明距离小
 */
function simHash(text: string, bits: number = 64): bigint {
  const tokens = tokenize(text);
  if (tokens.length === 0) return 0n;

  const v = new Int32Array(bits);

  for (const token of tokens) {
    let h = hashString(token);
    for (let i = 0; i < bits; i++) {
      v[i] += (h & 1) ? 1 : -1;
      h >>>= 1;
    }
  }

  let fingerprint = 0n;
  for (let i = 0; i < bits; i++) {
    if (v[i] > 0) fingerprint |= (1n << BigInt(i));
  }

  return fingerprint;
}

/** 简单分词 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fff]+/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1);
}

/** 字符串哈希 */
function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

/** 海明距离 */
function hammingDistance(a: bigint, b: bigint): number {
  let x = a ^ b;
  let count = 0;
  while (x !== 0n) {
    count++;
    x &= x - 1n;
  }
  return count;
}

export class SemanticAnalyzer {
  private ngramSize: number;
  private similarityThreshold: number;
  private fingerprints: { turn: number; hash: bigint; text: string }[] = [];

  constructor(ngramSize: number = 3, similarityThreshold: number = 0.85) {
    this.ngramSize = ngramSize;
    this.similarityThreshold = similarityThreshold;
  }

  /** 检测语义循环 */
  detect(steps: TraceStep[]): DetectionResult {
    // 提取最近助手输出的文本
    const textSteps = steps.filter(s => s.textOutput && s.textOutput.length > 20);
    if (textSteps.length < 3) {
      return { detected: false, confidence: 0 };
    }

    // 计算每轮的 SimHash
    const recentTexts = textSteps.slice(-10);
    const fingerprints = recentTexts.map(s => ({
      turn: s.turnIndex,
      hash: simHash(s.textOutput!.slice(0, 2000)),
      text: s.textOutput!.slice(0, 100),
    }));

    // 检测连续相似
    let consecutiveSimilar = 0;
    const maxBits = 64;

    for (let i = fingerprints.length - 1; i > 0; i--) {
      const dist = hammingDistance(fingerprints[i].hash, fingerprints[i - 1].hash);
      const similarity = 1 - dist / maxBits;

      if (similarity >= this.similarityThreshold) {
        consecutiveSimilar++;
      } else {
        break;
      }
    }

    if (consecutiveSimilar >= 3) {
      return {
        detected: true,
        confidence: Math.min(0.75, 0.4 + consecutiveSimilar * 0.1),
        pattern: 'semantic_loop',
        detail: `连续 ${consecutiveSimilar} 轮文本输出语义高度相似`,
        evidenceIndices: recentTexts.slice(-consecutiveSimilar).map(s => s.id),
      };
    }

    return { detected: false, confidence: 0 };
  }

  /** 重置 */
  reset(): void {
    this.fingerprints = [];
  }
}
