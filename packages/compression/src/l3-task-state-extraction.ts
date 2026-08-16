/**
 * L3 - 任务状态提取 (TaskStateExtraction)
 *
 * 将整个对话历史结构化提取为 TaskState JSON，丢弃叙事细节。
 * 触发条件: L2 后 estimatedTokens > contextWindow × 0.85
 *
 * 关键修复：
 *  - 保留所有 pinned 资源（compaction_summary / checkpoint_ref 等），不再只保留 recent
 *  - forkModel / forkMaxTokens 真正生效
 *  - fork 失败时记录失败遥测，不修改 resources
 */

import { randomUUID } from 'node:crypto';
import type {
  ContextResource, Model, Context, StreamFn,
} from '@aipack-ai/agent';
import { extractTextFromResource } from '@aipack-ai/agent';
import type { TokenEstimator } from './token-estimator';
import type { CompressionTelemetry } from './telemetry';
import { createTelemetry } from './telemetry';
import type { CompressionSafetyState } from './safety';
import type { CompressResult } from './l1-tool-output-trim';
import { runForkWithRetry, ForkStreamError, type RetryConfig, type ForkResult, type ForkCallbackResult } from './retry';

export interface L3Config {
  enabled: boolean;
  threshold: number;
  targetRatio: number;
  forkModel?: string;
  forkMaxTokens: number;
  protectedRecentCount: number;
}

export interface TaskState {
  originalRequest: string;
  currentPhase: string;
  completedSteps: string[];
  pendingSteps: string[];
  keyDecisions: string[];
  constraints: string[];
  toolResults: {
    tool: string;
    status: 'success' | 'failure' | 'partial';
    summary: string;
  }[];
  errors: string[];
  variables: Record<string, unknown>;
}

const L3_PROMPT = `You are a task state extraction agent.
Extract a structured JSON object representing the current task state from the conversation history.
Be extremely concise. Only include information necessary for continued execution.

Output valid JSON:
{
  "originalRequest": "Core user request (1-2 sentences)",
  "currentPhase": "Current execution phase",
  "completedSteps": ["step1", "step2"],
  "pendingSteps": ["step1"],
  "keyDecisions": ["decision1"],
  "constraints": ["constraint1"],
  "toolResults": [
    {"tool": "name", "status": "success|failure|partial", "summary": "result"}
  ],
  "errors": ["error1"],
  "variables": {"key": "value"}
}`;

export class TaskStateExtraction {
  constructor(
    private estimator: TokenEstimator,
    private streamFn: StreamFn,
    private model: Model,
    private config: L3Config,
    /** P0#1/#4: 单次 fork 超时（ms），由 transformer 注入 */
    private forkTimeoutMs: number,
    /** P0#4: 重试配置 */
    private retry: RetryConfig,
  ) {}

  async compress(
    resources: ContextResource[],
    contextWindow: number,
    safety: CompressionSafetyState,
    sessionKey: string,
    turn: number,
  ): Promise<CompressResult> {
    if (!this.config.enabled) return { resources, telemetry: [] };

    const allContent = this.extractAllContent(resources);
    const forkOut = await this.forkExtract(allContent, safety, sessionKey, turn);

    if (!forkOut.ok || !forkOut.value) {
      return {
        resources,
        telemetry: [createTelemetry('L3', 'task_state_extraction', 0, 0, {
          sessionKey, turn,
          failed: true,
          message: 'fork_extract_returned_empty',
          compressionDepth: safety.compressionDepth,
          forkDurationMs: forkOut.durationMs,
          forkRetries: forkOut.retries,
          forkModelId: this.resolveForkModel().id,
        })],
      };
    }
    const taskState = forkOut.value;

    const taskStateResource: ContextResource = {
      // P1#8: 用 randomUUID 替代 Date.now()
      id: `task_state_${randomUUID()}`,
      type: 'custom',
      role: 'taskState',
      content: taskState,
      timestamp: Date.now(),
      dependencies: [],
      meta: {
        _compressionLevel: 3,
        _sourceResourceCount: resources.length,
      },
      pinned: true,
    };

    // 关键修复：保留所有 pinned 资源（compaction_summary / checkpoint_ref / handoff 等）
    // + 最近 N 条非 pinned 资源；不再粗暴丢弃 pinned
    const pinned = resources.filter(r => r.pinned);
    const unpinned = resources.filter(r => !r.pinned);
    const recent = unpinned.slice(-this.config.protectedRecentCount);

    // 去重：pinned 中已包含的资源不再重复加入 recent
    const pinnedIds = new Set(pinned.map(r => r.id));
    const newRecent = recent.filter(r => !pinnedIds.has(r.id));

    // 如果已存在旧 task_state（pinned），用新的替换之
    const filteredPinned = pinned.filter(r => r.role !== 'taskState');

    const result = [taskStateResource, ...filteredPinned, ...newRecent]
      .sort((a, b) => a.timestamp - b.timestamp);

    const beforeTokens = this.estimator.estimateAll(resources);
    const afterTokens = this.estimator.estimateAll(result);
    const telemetry = createTelemetry('L3', 'task_state_extraction', beforeTokens, afterTokens, {
      sessionKey, turn,
      resourcesAffected: resources.length - recent.length - pinned.length,
      cachePreserved: false,
      compressionDepth: safety.compressionDepth + 1,
      forkDurationMs: forkOut.durationMs,
      forkRetries: forkOut.retries,
      forkModelId: this.resolveForkModel().id,
      forkUsage: forkOut.usage,
    });

    safety.compressionDepth++;
    return { resources: result, telemetry: [telemetry] };
  }

  private extractAllContent(resources: ContextResource[]): string {
    return resources
      .filter(r => r.type !== 'system_message' && r.type !== 'state_snapshot')
      .map(r => {
        const text = extractTextFromResource(r);
        return `[${r.type}] ${text}`;
      })
      .join('\n\n');
  }

  private async forkExtract(
    allContent: string,
    safety: CompressionSafetyState,
    sessionKey: string,
    turn: number,
  ): Promise<ForkResult<TaskState>> {
    const forkModel = this.resolveForkModel();
    const context: Context = {
      systemPrompt: L3_PROMPT,
      messages: [{
        role: 'user',
        content: `Extract task state from:\n\n${allContent}`,
        timestamp: Date.now(),
      }],
    };

    // P2#16: 透传 sessionId
    const forkSessionId = `${sessionKey}#L3#t${turn}`;

    const out = await runForkWithRetry(
      safety,
      this.forkTimeoutMs,
      this.retry,
      async (signal) => {
        let text = '';
        let usage: ForkCallbackResult<string>['usage'];
        for await (const event of this.streamFn(forkModel, context, {
          signal,
          sessionId: forkSessionId,
        })) {
          if (event.type === 'text_delta') text += event.delta;
          if (event.type === 'done' && event.message.usage) {
            usage = {
              input: event.message.usage.input,
              output: event.message.usage.output,
              total: event.message.usage.total,
            };
          }
          if (event.type === 'error') {
            const errMsg = event.message as { errorMessage?: string; status?: number } | undefined;
            throw new ForkStreamError(
              errMsg?.errorMessage ?? 'stream_error',
              true,
              errMsg?.status,
            );
          }
        }
        return { value: text || null, usage };
      },
    );

    if (!out.ok || !out.value) {
      return { ok: false, value: null, retries: out.retries, durationMs: out.durationMs };
    }

    // 尝试提取 JSON（可能被包裹在 ```json ... ``` 中）
    const jsonMatch = out.value.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonStr = jsonMatch ? jsonMatch[1].trim() : out.value.trim();

    try {
      return {
        ok: true,
        value: JSON.parse(jsonStr) as TaskState,
        retries: out.retries,
        durationMs: out.durationMs,
        usage: out.usage,
      };
    } catch {
      // P1#12 修复：JSON 解析失败返回 null，让 L3 记失败遥测、不替换 resources。
      // 旧实现把模型自由文本塞进 originalRequest，等价于信息全丢却被当成有效 taskState
      // 后续 L4/L5 会基于这个残缺对象继续，污染下游。
      return { ok: false, value: null, retries: out.retries, durationMs: out.durationMs };
    }
  }

  /** 解析 fork 用模型 */
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

/** 从资源列表中查找已有的 TaskState */
export function findTaskState(resources: ContextResource[]): TaskState | undefined {
  const r = resources.find(r => r.role === 'taskState');
  return r?.content as TaskState | undefined;
}
