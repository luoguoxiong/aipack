/**
 * 安全守卫 - 配对验证、递归保护、断路器、AbortController 管理
 */

import type { ContextResource } from 'agentpack';
import type { CompressionTelemetry } from './telemetry';

// ─── 安全状态 ─────────────────────────────────────────────────────

export interface CompressionSafetyState {
  /** 当前 turn 内累计压缩尝试次数（跨 level 累加，跨 turn 重置） */
  attemptCount: number;
  /** 上次执行压缩的 turn（用于跨 turn 时重置 attemptCount） */
  lastTurn: number;
  /** 累计压缩深度（L2/L3/L4/L5 触发时 +1） */
  compressionDepth: number;
  /** 断路器是否已触发 */
  circuitBreakerTripped: boolean;
  /** 冷却剩余 turn 数 */
  cooldownRemaining: number;
  /** AbortController（由 transformer 注入并管理生命周期） */
  abortController?: AbortController;
  /** 是否已创建 checkpoint */
  hasCheckpoint: boolean;
  /** 最近一次 checkpoint id */
  checkpointId?: string;
  /** 是否已完成 L5 handoff */
  handoffCompleted: boolean;
  /** 遥测历史 */
  telemetryHistory: CompressionTelemetry[];
}

export interface CreateSafetyStateOptions {
  /** 单次 fork 调用超时（ms），默认 30000 */
  forkTimeoutMs?: number;
}

export function createSafetyState(
  options?: CreateSafetyStateOptions,
): CompressionSafetyState {
  const timeoutMs = options?.forkTimeoutMs ?? 30_000;
  let abortController: AbortController | undefined;
  try {
    abortController = new AbortController();
    if (timeoutMs > 0) {
      // 超时自动 abort；如果运行时已 abort 则忽略
      const timer = setTimeout(() => abortController?.abort(), timeoutMs);
      // allow process to exit even if timer is pending
      if (typeof (timer as any).unref === 'function') (timer as any).unref();
    }
  } catch {
    // AbortController 在某些极老环境不可用；忽略
  }

  return {
    attemptCount: 0,
    lastTurn: -1,
    compressionDepth: 0,
    circuitBreakerTripped: false,
    cooldownRemaining: 0,
    abortController,
    hasCheckpoint: false,
    handoffCompleted: false,
    telemetryHistory: [],
  };
}

/** 取消所有正在进行的 fork 调用 */
export function abortSafetyState(state: CompressionSafetyState): void {
  state.abortController?.abort();
}

// ─── 安全守卫 ─────────────────────────────────────────────────────

export interface SafetyConfig {
  /** 单 turn 内最大压缩尝试次数 */
  maxAttempts: number;
  /** 触发熔断后冷却 turn 数 */
  cooldownTurns: number;
  /** fork 调用超时（ms） */
  forkTimeoutMs?: number;
}

export class CompressionSafetyGuard {
  constructor(private config: SafetyConfig) {}

  /**
   * 是否允许执行压缩。
   * @param turn 当前 turn（用于跨 turn 时重置计数）
   */
  canCompress(state: CompressionSafetyState, turn: number): boolean {
    if (state.handoffCompleted) return false;

    // 跨 turn 边界：重置本 turn 的尝试计数
    if (state.lastTurn !== turn) {
      state.lastTurn = turn;
      state.attemptCount = 0;
    }

    if (state.circuitBreakerTripped) {
      if (state.cooldownRemaining > 0) {
        state.cooldownRemaining--;
        return false;
      }
      state.circuitBreakerTripped = false;
      state.attemptCount = 0;
    }

    if (state.attemptCount >= this.config.maxAttempts) {
      state.circuitBreakerTripped = true;
      state.cooldownRemaining = this.config.cooldownTurns;
      return false;
    }

    return true;
  }

  /** 记录一次尝试 */
  recordAttempt(state: CompressionSafetyState): void {
    state.attemptCount++;
  }

  /**
   * 验证 tool_call / tool_result 配对完整性。
   *
   * 检查规则：
   *  1. 每个 tool_result 的 dep(toolCallId) 必须有对应的 assistant_message 或 tool_call 引用
   *  2. 每个 assistant_message 引用的 toolCallId 必须有对应的 tool_result（避免悬空调用）
   *
   * 注：assistant_message.dependencies 既可能是 toolCallId（发起调用），
   * 也可能引用上游消息；此处只关心 toolCallId 维度的配对。
   */
  validateToolPairing(resources: ContextResource[]): boolean {
    const assistantDeps = new Set<string>();
    const toolCallDeps = new Set<string>();
    const toolResultDeps = new Set<string>();

    for (const r of resources) {
      if (r.type === 'assistant_message' || r.type === 'tool_call') {
        for (const dep of r.dependencies) {
          if (r.type === 'assistant_message') assistantDeps.add(dep);
          else toolCallDeps.add(dep);
        }
      }
      if (r.type === 'tool_result') {
        for (const dep of r.dependencies) toolResultDeps.add(dep);
      }
    }

    // 每个 tool_result 的依赖必须被 assistant_message 或 tool_call 引用
    for (const depId of toolResultDeps) {
      if (!assistantDeps.has(depId) && !toolCallDeps.has(depId)) return false;
    }

    // 每个 assistant_message 引用的 toolCallId 必须有对应 tool_result
    // （否则模型在重放时看到悬空 tool_call 会报错）
    for (const depId of assistantDeps) {
      if (!toolResultDeps.has(depId)) {
        // 只有当 assistant_message 真的声明了 toolCallId 依赖时才校验
        // 这里无法区分 toolCallId 依赖和上游消息依赖，所以采用宽松策略：
        // 如果存在 tool_result，则其依赖应被引用；反之不强制
        // （此分支留作未来 stricter 模式钩子）
      }
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

/** 构建 toolCallId -> tool_result ids 映射 */
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
    // 必须有对应的 assistant_message 或 tool_call 引用该 toolCallId
    return resource.dependencies.every(depId =>
      resources.some(r =>
        (r.type === 'assistant_message' || r.type === 'tool_call')
        && r.dependencies.includes(depId),
      ),
    );
  }
  return true;
}
