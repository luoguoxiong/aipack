/**
 * L1 - 工具输出裁剪 (ToolOutputTrim)
 *
 * 无损/极低损耗操作，缓存安全：所有操作从尾部向头部扫描，前缀不变。
 * 触发条件: estimatedTokens > contextWindow × 0.60
 */

import type { ContextResource, ContentBlock } from '@aipack/agent';
import { extractTextFromResource } from '@aipack/agent';
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

  /**
   * 从尾部向头部裁剪 tool_result。
   *
   * P1#11 修复：
   *  - 关键行匹配强化：扩展正则覆盖 JSON error、stack trace、FAIL/✗/panic/exception
   *  - 按行扫描不限行首，匹配整行包含关键字
   *  - 尝试从 JSON 输出提取 error/status/message 字段
   */
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

      // P1#11: 强化的关键行匹配
      const keyLines = this.extractKeyLines(lines);

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

  /**
   * P1#11: 强化的关键行提取。
   * - 匹配整行包含关键字（不限于行首）
   * - 覆盖：error/warn/fail/✗/panic/exception/traceback/✗/✘
   * - 尝试从 JSON 行提取 error/status/message 字段
   */
  private extractKeyLines(lines: string[]): string[] {
    const KEY_LINE_RE = /(error|warn|fail|✗|✘|panic|exception|traceback|fatal|critical)/i;
    const found: string[] = [];

    for (const line of lines) {
      if (found.length >= 5) break;
      if (KEY_LINE_RE.test(line)) {
        found.push(line);
        continue;
      }
      // 尝试 JSON 提取
      const jsonField = this.tryExtractJsonError(line);
      if (jsonField) found.push(jsonField);
    }
    return found;
  }

  /** P1#11: 尝试从单行 JSON 提取 error/status/message 字段 */
  private tryExtractJsonError(line: string): string | null {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
    try {
      const obj = JSON.parse(trimmed);
      const err = obj?.error ?? obj?.errors?.[0] ?? obj?.message;
      const status = obj?.status ?? obj?.code;
      if (err || status) {
        return `[json] status=${status ?? 'n/a'}: ${typeof err === 'string' ? err : JSON.stringify(err)}`;
      }
    } catch {
      // 非 JSON，忽略
    }
    return null;
  }

  /**
   * 空白规范化：合并多余空行。
   * 仅对 string 类型 content 做整段规范化；对 ContentBlock[] 仅规范化其中
   * 的 text 块，保留其他类型块（image/tool_use 等）的原始结构。
   */
  private normalizeWhitespace(resources: ContextResource[]): ContextResource[] {
    return resources.map(r => {
      if (r.type === 'system_message' || r.type === 'state_snapshot') return r;

      // string content：整段规范化
      if (typeof r.content === 'string') {
        const normalized = normalizeWs(r.content);
        if (normalized === r.content) return r;
        this.estimator.invalidate(r.id);
        return { ...r, content: normalized };
      }

      // ContentBlock[]：仅规范化 text 块，保留其他块结构
      if (Array.isArray(r.content)) {
        let changed = false;
        const newContent = (r.content as ContentBlock[]).map(b => {
          if (b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string') {
            const normalized = normalizeWs(b.text);
            if (normalized !== b.text) {
              changed = true;
              return { ...b, text: normalized };
            }
          }
          return b;
        });
        if (!changed) return r;
        this.estimator.invalidate(r.id);
        return { ...r, content: newContent };
      }

      return r;
    });
  }
}

/** 空白规范化辅助：合并 3+ 换行为 2 个，去除行尾空格，整段 trim */
function normalizeWs(text: string): string {
  return text
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
}
