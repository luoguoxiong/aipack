/**
 * L2 - 旧消息摘要 (MessageSummarize)
 *
 * 通过 Fork Agent 生成摘要替换旧消息块，缓存前缀保留。
 * 触发条件: L1 后 estimatedTokens > contextWindow × 0.75
 */

import type {
  ContextResource, Model, Context, StreamFn, StreamEvent,
} from 'agentpack';
import { extractTextFromResource } from 'agentpack';
import type { TokenEstimator } from './token-estimator';
import type { CompressionTelemetry } from './telemetry';
import { createTelemetry } from './telemetry';
import type { CompressionSafetyState } from './safety';
import { buildToolPairMap, isToolPairComplete } from './safety';
import type { CompressResult } from './l1-tool-output-trim';

export interface L2Config {
  enabled: boolean;
  threshold: number;
  targetRatio: number;
  forkModel?: string;
  forkMaxTokens: number;
  minResourcesToCompress: number;
  protectedRecentCount: number;
  maxCompressionDepth: number;
}

const L2_PROMPT = `You are a context compression agent.
Summarize the conversation history into a concise, structured summary.
Preserve all critical information for continued task execution.

Output format:

## Context Summary
[Core user intent and current task state]

## Key Decisions
- [Decision 1]

## Tool Results
- [Tool name]: [Key result/outcome]

## Pending Actions
- [Action 1]`;

export class MessageSummarize {
  constructor(
    private estimator: TokenEstimator,
    private streamFn: StreamFn,
    private model: Model,
    private config: L2Config,
  ) {}

  async compress(
    resources: ContextResource[],
    contextWindow: number,
    safety: CompressionSafetyState,
    sessionKey: string,
    turn: number,
  ): Promise<CompressResult> {
    if (!this.config.enabled) return { resources, telemetry: [] };

    if (safety.compressionDepth >= this.config.maxCompressionDepth) {
      return { resources, telemetry: [] };
    }

    const compressible = this.identifyCompressible(resources);
    if (compressible.length < this.config.minResourcesToCompress) {
      return { resources, telemetry: [] };
    }

    const transcript = compressible
      .map(r => this.formatResource(r))
      .join('\n\n');

    const summary = await this.forkSummarize(transcript, safety);
    if (!summary) return { resources, telemetry: [] };

    const summaryResource: ContextResource = {
      id: `compaction_${Date.now()}`,
      type: 'compaction_summary',
      role: 'system',
      content: summary,
      timestamp: Date.now(),
      dependencies: [],
      meta: {
        _compressionLevel: 2,
        _compressionDepth: safety.compressionDepth + 1,
        _sourceCount: compressible.length,
      },
      pinned: true,
    };

    const prefixEnd = resources.indexOf(compressible[0]);
    const suffixStart = resources.indexOf(compressible[compressible.length - 1]) + 1;
    const result = [
      ...resources.slice(0, prefixEnd),
      summaryResource,
      ...resources.slice(suffixStart),
    ];

    const beforeTokens = this.estimator.estimateAll(resources);
    const afterTokens = this.estimator.estimateAll(result);
    const telemetry = createTelemetry('L2', 'message_summarize', beforeTokens, afterTokens, {
      sessionKey, turn,
      resourcesAffected: compressible.length,
      cachePreserved: prefixEnd > 0,
      compressionDepth: safety.compressionDepth + 1,
    });

    safety.compressionDepth++;
    return { resources: result, telemetry: [telemetry] };
  }

  /** 识别可压缩块 */
  private identifyCompressible(resources: ContextResource[]): ContextResource[] {
    const recent = resources.slice(-this.config.protectedRecentCount);
    const recentIds = new Set(recent.map(r => r.id));
    const pairMap = buildToolPairMap(resources);

    return resources.filter(r => {
      if (r.pinned) return false;
      if (recentIds.has(r.id)) return false;
      if (r.type === 'compaction_summary') return false;
      if (r.type === 'system_message' || r.type === 'state_snapshot') return false;
      if (r.role === 'taskState') return false;
      if (!isToolPairComplete(r, resources, pairMap)) return false;
      return true;
    });
  }

  /** 格式化资源为摘要输入文本 */
  private formatResource(r: ContextResource): string {
    const text = extractTextFromResource(r);
    return `[${r.type}] ${text}`;
  }

  /** Fork Agent 摘要请求 */
  private async forkSummarize(
    transcript: string,
    safety: CompressionSafetyState,
  ): Promise<string | null> {
    const context: Context = {
      systemPrompt: L2_PROMPT,
      messages: [{
        role: 'user',
        content: `Summarize the following conversation history:\n\n${transcript}`,
        timestamp: Date.now(),
      }],
    };

    try {
      let summary = '';
      for await (const event of this.streamFn(this.model, context, {
        signal: safety.abortSignal,
      })) {
        if (event.type === 'text_delta') summary += event.delta;
        if (event.type === 'error') return null;
      }
      return summary || null;
    } catch {
      return null;
    }
  }
}
