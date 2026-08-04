/**
 * L1 - 工具输出裁剪 (ToolOutputTrim)
 *
 * 无损/极低损耗操作，缓存安全：所有操作从尾部向头部扫描，前缀不变。
 * 触发条件: estimatedTokens > contextWindow × 0.60
 */

import type { ContextResource, ContentBlock } from 'agentpack';
import { extractTextFromResource } from 'agentpack';
import type { TokenEstimator } from './token-estimator';
import type { CompressionTelemetry } from './telemetry';
import { createTelemetry } from './telemetry';

export interface L1Config {
  enabled: boolean;
  threshold: number;
  targetRatio: number;
  stripThinking: boolean;
  trimToolResults: boolean;
  toolResultMaxLines: number;
  toolResultHeadLines: number;
  toolResultTailLines: number;
  normalizeWhitespace: boolean;
}

export interface CompressResult {
  resources: ContextResource[];
  telemetry: CompressionTelemetry[];
}

export class ToolOutputTrim {
  constructor(
    private estimator: TokenEstimator,
    private config: L1Config,
  ) {}

  async compress(
    resources: ContextResource[],
    contextWindow: number,
    sessionKey: string,
    turn: number,
  ): Promise<CompressResult> {
    if (!this.config.enabled) return { resources, telemetry: [] };

    const target = contextWindow * this.config.targetRatio;
    const telemetry: CompressionTelemetry[] = [];
    let current = [...resources];
    const beforeTokens = this.estimator.estimateAll(current);

    if (beforeTokens <= target) return { resources: current, telemetry };

    // ── 操作 1: 剥离 thinking 块 ──
    if (this.config.stripThinking) {
      const before = this.estimator.estimateAll(current);
      current = this.stripThinkingBlocks(current);
      const after = this.estimator.estimateAll(current);
      if (after < before) {
        telemetry.push(createTelemetry('L1', 'strip_thinking', before, after, {
          sessionKey, turn, resourcesAffected: current.length,
        }));
      }
      if (after <= target) return { resources: current, telemetry };
    }

    // ── 操作 2: 工具结果智能裁剪 ──
    if (this.config.trimToolResults) {
      const before = this.estimator.estimateAll(current);
      const tokensToFree = before - target;
      current = this.trimToolResults(current, tokensToFree);
      const after = this.estimator.estimateAll(current);
      if (after < before) {
        telemetry.push(createTelemetry('L1', 'trim_tool_result', before, after, {
          sessionKey, turn, resourcesAffected: current.length,
        }));
      }
      if (after <= target) return { resources: current, telemetry };
    }

    // ── 操作 3: 空白规范化 ──
    if (this.config.normalizeWhitespace) {
      const before = this.estimator.estimateAll(current);
      current = this.normalizeWhitespace(current);
      const after = this.estimator.estimateAll(current);
      if (after < before) {
        telemetry.push(createTelemetry('L1', 'normalize_whitespace', before, after, {
          sessionKey, turn, resourcesAffected: current.length,
        }));
      }
    }

    return { resources: current, telemetry };
  }

  /** 剥离 assistant_message 中的 thinking 内容块 */
  private stripThinkingBlocks(resources: ContextResource[]): ContextResource[] {
    return resources.map(r => {
      if (r.type !== 'assistant_message') return r;
      const content = r.content as ContentBlock[];
      if (!Array.isArray(content)) return r;
      const filtered = content.filter(b => b.type !== 'thinking');
      if (filtered.length === content.length) return r;
      this.estimator.invalidate(r.id);
      return { ...r, content: filtered };
    });
  }

  /** 从尾部向头部裁剪 tool_result */
  private trimToolResults(
    resources: ContextResource[],
    tokensToFree: number,
  ): ContextResource[] {
    if (tokensToFree <= 0) return resources;

    let freed = 0;
    const result = [...resources];

    for (let i = result.length - 1; i >= 0 && freed < tokensToFree; i--) {
      const r = result[i];
      if (r.type !== 'tool_result' || r.pinned) continue;

      const text = extractTextFromResource(r);
      const lines = text.split('\n');
      if (lines.length <= this.config.toolResultMaxLines) continue;

      const headLines = lines.slice(0, this.config.toolResultHeadLines);
      const tailLines = lines.slice(-this.config.toolResultTailLines);
      const keyLines = lines
        .filter(l => /^(error|warning|result|summary|fail)/i.test(l.trim()))
        .slice(0, 3);

      const omitted = lines.length - headLines.length - tailLines.length;
      const truncated = [
        ...headLines,
        `\n[... truncated ${omitted} lines ...]`,
        ...keyLines,
        ...tailLines,
      ].join('\n');

      const beforeTokens = this.estimator.estimate(r);
      this.estimator.invalidate(r.id);
      result[i] = {
        ...r,
        content: [{ type: 'text', text: truncated }],
        meta: { ...r.meta, _trimmed: true, _originalLines: lines.length },
      };
      freed += beforeTokens - this.estimator.estimate(result[i]);
    }

    return result;
  }

  /** 空白规范化：合并多余空行 */
  private normalizeWhitespace(resources: ContextResource[]): ContextResource[] {
    return resources.map(r => {
      if (r.type === 'system_message' || r.type === 'state_snapshot') return r;
      const text = extractTextFromResource(r);
      if (!text) return r;
      const normalized = text
        .replace(/\n{3,}/g, '\n\n')
        .replace(/[ \t]+$/gm, '')
        .trim();
      if (normalized === text) return r;
      this.estimator.invalidate(r.id);
      return {
        ...r,
        content: typeof r.content === 'string' ? normalized : [{ type: 'text', text: normalized }],
      };
    });
  }
}
