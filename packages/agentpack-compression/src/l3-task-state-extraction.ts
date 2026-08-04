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

import type {
  ContextResource, Model, Context, StreamFn,
} from 'agentpack';
import { extractTextFromResource } from 'agentpack';
import type { TokenEstimator } from './token-estimator';
import type { CompressionTelemetry } from './telemetry';
import { createTelemetry } from './telemetry';
import type { CompressionSafetyState } from './safety';
import type { CompressResult } from './l1-tool-output-trim';

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
    const taskState = await this.forkExtract(allContent, safety);

    if (!taskState) {
      return {
        resources,
        telemetry: [createTelemetry('L3', 'task_state_extraction', 0, 0, {
          sessionKey, turn,
          failed: true,
          message: 'fork_extract_returned_empty',
          compressionDepth: safety.compressionDepth,
        })],
      };
    }

    const taskStateResource: ContextResource = {
      id: `task_state_${Date.now()}`,
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
  ): Promise<TaskState | null> {
    const forkModel = this.resolveForkModel();
    const context: Context = {
      systemPrompt: L3_PROMPT,
      messages: [{
        role: 'user',
        content: `Extract task state from:\n\n${allContent}`,
        timestamp: Date.now(),
      }],
    };

    try {
      let output = '';
      for await (const event of this.streamFn(forkModel, context, {
        signal: safety.abortController?.signal,
      })) {
        if (event.type === 'text_delta') output += event.delta;
        if (event.type === 'error') return null;
      }

      // 尝试提取 JSON（可能被包裹在 ```json ... ``` 中）
      const jsonMatch = output.match(/```(?:json)?\s*([\s\S]*?)```/);
      const jsonStr = jsonMatch ? jsonMatch[1].trim() : output.trim();

      try {
        return JSON.parse(jsonStr) as TaskState;
      } catch {
        // JSON 解析失败：返回带原始输出的兜底 TaskState
        return {
          originalRequest: output.slice(0, 500),
          currentPhase: 'unknown',
          completedSteps: [],
          pendingSteps: [],
          keyDecisions: [],
          constraints: [],
          toolResults: [],
          errors: ['failed_to_parse_json'],
          variables: {},
        };
      }
    } catch {
      return null;
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
