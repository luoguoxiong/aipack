/**
 * L2 - 旧消息摘要 (MessageSummarize)
 *
 * 通过 Fork Agent 生成摘要替换旧消息块，缓存前缀保留。
 * 触发条件: L1 后 estimatedTokens > contextWindow × 0.75
 *
 * 关键修复：
 *  - 切分逻辑改用 id 集合判定，避免误删夹在中间的 system_message/state_snapshot
 *  - compressionDepth 改为单次 pipeline 内的本地计数（不跨 turn 累积）
 *  - forkModel / forkMaxTokens 真正生效（克隆 Model 并覆盖 maxTokens）
 *  - targetRatio 用于判断压缩后是否达标，未达标会通过 telemetry 标注
 */

import type {
  ContextResource, Model, Context, StreamFn,
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

    // compressionDepth 改为单次 pipeline 本地计数，不跨 turn 累积
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
    if (!summary) {
      // fork 失败：记录失败遥测，不修改 resources
      return {
        resources,
        telemetry: [createTelemetry('L2', 'message_summarize', 0, 0, {
          sessionKey, turn,
          failed: true,
          message: 'fork_summarize_returned_empty',
          compressionDepth: safety.compressionDepth,
        })],
      };
    }

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

    // 切分：用 id 集合判定，避免误删夹在中间的不可压缩资源（system_message 等）
    const compressibleIds = new Set(compressible.map(r => r.id));
    let firstIdx = -1;
    let lastIdx = -1;
    for (let i = 0; i < resources.length; i++) {
      if (compressibleIds.has(resources[i].id)) {
        if (firstIdx === -1) firstIdx = i;
        lastIdx = i;
      }
    }
    if (firstIdx === -1 || lastIdx < firstIdx) {
      // 兜底：理论上不会走到
      return { resources, telemetry: [] };
    }

    // 把区间 [firstIdx, lastIdx] 内的所有可压缩资源替换为 summary，
    // 区间内不可压缩的资源（如 system_message）原样保留
    const beforeSlice = resources.slice(0, firstIdx);
    const middleSlice = resources.slice(firstIdx, lastIdx + 1).filter(r => !compressibleIds.has(r.id));
    const afterSlice = resources.slice(lastIdx + 1);
    const result = [...beforeSlice, summaryResource, ...middleSlice, ...afterSlice];

    const beforeTokens = this.estimator.estimateAll(resources);
    const afterTokens = this.estimator.estimateAll(result);
    const targetTokens = contextWindow * this.config.targetRatio;
    const reachedTarget = afterTokens <= targetTokens;

    const telemetry = createTelemetry('L2', 'message_summarize', beforeTokens, afterTokens, {
      sessionKey, turn,
      resourcesAffected: compressible.length,
      cachePreserved: firstIdx > 0,
      compressionDepth: safety.compressionDepth + 1,
      message: reachedTarget ? undefined : `above_target:${Math.round(afterTokens - targetTokens)}`,
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
    const forkModel = this.resolveForkModel();
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
      for await (const event of this.streamFn(forkModel, context, {
        signal: safety.abortController?.signal,
      })) {
        if (event.type === 'text_delta') summary += event.delta;
        if (event.type === 'error') return null;
      }
      return summary || null;
    } catch {
      return null;
    }
  }

  /** 解析 fork 用模型：若配置了 forkModel 则克隆主模型并切换 id，否则用主模型 */
  private resolveForkModel(): Model {
    const { forkModel, forkMaxTokens } = this.config;
    if (!forkModel && !forkMaxTokens) return this.model;
    return {
      ...this.model,
      ...(forkModel ? { id: forkModel, name: forkModel } : {}),
      maxTokens: forkMaxTokens || this.model.maxTokens,
    };
  }
}
