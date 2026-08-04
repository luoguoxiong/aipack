/**
 * 安全守卫 - 配对验证、递归保护、断路器
 */

import type { ContextResource } from 'agentpack';
import type { CompressionTelemetry } from './telemetry';

// ─── 安全状态 ─────────────────────────────────────────────────────

export interface CompressionSafetyState {
  compressionDepth: number;
  attemptCount: number;
  circuitBreakerTripped: boolean;
  cooldownRemaining: number;
  abortSignal?: AbortSignal;
  hasCheckpoint: boolean;
  checkpointId?: string;
  handoffCompleted: boolean;
  telemetryHistory: CompressionTelemetry[];
}

export function createSafetyState(): CompressionSafetyState {
  return {
    compressionDepth: 0,
    attemptCount: 0,
    circuitBreakerTripped: false,
    cooldownRemaining: 0,
    hasCheckpoint: false,
    handoffCompleted: false,
    telemetryHistory: [],
  };
}

// ─── 安全守卫 ─────────────────────────────────────────────────────

export interface SafetyConfig {
  maxAttempts: number;
  cooldownTurns: number;
}

export class CompressionSafetyGuard {
  constructor(private config: SafetyConfig) {}

  /** 是否允许执行压缩 */
  canCompress(state: CompressionSafetyState): boolean {
    if (state.handoffCompleted) return false;

    if (state.circuitBreakerTripped) {
      if (state.cooldownRemaining > 0) {
        state.cooldownRemaining--;
        return false;
      }
      state.circuitBreakerTripped = false;
      state.attemptCount = 0;
    }

    if (state.attemptCount >= this.config.maxAttempts) {
      state.cooldownRemaining = this.config.cooldownTurns;
      return false;
    }

    return true;
  }

  /** 验证 tool_call / tool_result 配对完整性 */
  validateToolPairing(resources: ContextResource[]): boolean {
    // assistant_message 的 dependencies 指向 toolCallId
    // tool_result 的 dependencies 也指向 toolCallId
    // 验证：每个 tool_result 的依赖至少被某个 assistant_message 依赖
    const assistantDeps = new Set<string>();
    const toolResultDeps = new Set<string>();

    for (const r of resources) {
      if (r.type === 'assistant_message') {
        for (const dep of r.dependencies) assistantDeps.add(dep);
      }
      if (r.type === 'tool_result') {
        for (const dep of r.dependencies) toolResultDeps.add(dep);
      }
    }

    // 每个 tool_result 的依赖必须被某个 assistant_message 引用
    for (const depId of toolResultDeps) {
      if (!assistantDeps.has(depId)) return false;
    }

    return true;
  }

  /** 验证 message.id 块不可分离性 */
  validateMessageIntegrity(
    before: ContextResource[],
    after: ContextResource[],
  ): boolean {
    const beforeGroups = this.groupByMessageId(before);
    const afterGroups = this.groupByMessageId(after);

    for (const [msgId, group] of afterGroups) {
      const beforeGroup = beforeGroups.get(msgId);
      if (beforeGroup && beforeGroup.length !== group.length) {
        return false;
      }
    }
    return true;
  }

  private groupByMessageId(resources: ContextResource[]): Map<string, ContextResource[]> {
    const groups = new Map<string, ContextResource[]>();
    for (const r of resources) {
      const groupId = (r.meta.toolCallId as string) ?? r.id;
      if (!groups.has(groupId)) groups.set(groupId, []);
      groups.get(groupId)!.push(r);
    }
    return groups;
  }
}

// ─── 工具配对辅助 ─────────────────────────────────────────────────

/** 构建 assistant_message(toolCallId) <-> tool_result 配对映射 */
export function buildToolPairMap(resources: ContextResource[]): Map<string, string[]> {
  const pairs = new Map<string, string[]>();

  for (const r of resources) {
    if (r.type === 'tool_result') {
      for (const dep of r.dependencies) {
        if (!pairs.has(dep)) pairs.set(dep, []);
        pairs.get(dep)!.push(r.id);
      }
    }
  }

  return pairs;
}

/** 检查资源是否属于完整的工具对 */
export function isToolPairComplete(
  resource: ContextResource,
  resources: ContextResource[],
  pairMap: Map<string, string[]>,
): boolean {
  if (resource.type === 'assistant_message') {
    // assistant_message 的 dependencies 是 toolCallId
    // 如果有 toolCallId，必须有对应的 tool_result
    return resource.dependencies.every(depId => pairMap.has(depId));
  }
  if (resource.type === 'tool_result') {
    // tool_result 的 dependencies 是 toolCallId
    // 必须有对应的 assistant_message 引用该 toolCallId
    return resource.dependencies.every(depId =>
      resources.some(r =>
        r.type === 'assistant_message' && r.dependencies.includes(depId),
      ),
    );
  }
  return true;
}
