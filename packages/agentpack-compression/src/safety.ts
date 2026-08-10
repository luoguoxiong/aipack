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
  /**
   * 单次 pipeline 内的累计压缩深度（L2/L3/L4/L5 触发时 +1）。
   * 由 transformer 在每次 run 开始时重置为 0 —— 不跨 turn 累积，
   * 避免运行几轮后 maxCompressionDepth 判断永久失效。
   */
  compressionDepth: number;
  /** 断路器是否已触发 */
  circuitBreakerTripped: boolean;
  /** 冷却剩余 turn 数 */
  cooldownRemaining: number;
  /**
   * Session 级 AbortController（仅用于外部主动取消整个 session，
   * 例如 LRU 淘汰 / 用户中断）。不用于单次 fork 超时。
   * 单次 fork 超时由 createForkAbortController 管理。
   */
  sessionAbortController?: AbortController;
  /** 当前是否有 in-flight fork（用于并发安全与 LRU 淘汰保护） */
  inFlightForks: number;
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
  /** 单次 fork 调用超时（ms），默认 30000；0 表示不自动超时（仍保留主动 abort 能力） */
  forkTimeoutMs?: number;
}

export function createSafetyState(
  options?: CreateSafetyStateOptions,
): CompressionSafetyState {
  // sessionAbortController 仅用于"主动取消整个 session"，不启动超时 timer。
  // 修复 P0#1：原实现在此处启动 setTimeout(forkTimeoutMs) 会在 30s 后永久 abort，
  // 导致长会话所有后续 fork 全部失败。单次 fork 超时改由 createForkAbortController 管理。
  let sessionAbortController: AbortController | undefined;
  try {
    sessionAbortController = new AbortController();
  } catch {
    // 极老环境无 AbortController；fork 将退化到无 signal
  }

  return {
    attemptCount: 0,
    lastTurn: -1,
    compressionDepth: 0,
    circuitBreakerTripped: false,
    cooldownRemaining: 0,
    sessionAbortController,
    inFlightForks: 0,
    hasCheckpoint: false,
    handoffCompleted: false,
    telemetryHistory: [],
  };
}

/**
 * 创建一次 fork 调用的 AbortController。
 *
 * 设计：每次 fork 都用独立的 AbortController + 局部 setTimeout，
 * 在 fork 结束时 clearTimeout，避免旧实现"创建 safetyState 时启动 30s timer
 * 永久 abort 整个 session"的致命 bug。
 *
 * 若 state 上有 sessionAbortController，则组合：session 级 abort 也能取消 fork。
 * 返回的 cleanup 必须在 finally 中调用。
 */
export function createForkAbortController(
  state: CompressionSafetyState,
  forkTimeoutMs: number,
): { signal: AbortSignal | undefined; cleanup: () => void } {
  const sessionSignal = state.sessionAbortController?.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let forkController: AbortController | undefined;

  try {
    if (sessionSignal?.aborted) {
      return { signal: sessionSignal, cleanup: () => {} };
    }

    forkController = new AbortController();

    if (forkTimeoutMs > 0) {
      timer = setTimeout(() => forkController?.abort(), forkTimeoutMs);
      if (typeof (timer as any).unref === 'function') (timer as any).unref();
    }

    // 组合 session 与 fork 两个 signal：任一 abort 即触发
    const anyFn = (AbortSignal as any).any;
    if (anyFn && sessionSignal) {
      const combined = anyFn([sessionSignal, forkController.signal]);
      return {
        signal: combined as AbortSignal,
        cleanup: () => { if (timer) clearTimeout(timer); },
      };
    }
    if (sessionSignal) {
      // 退化路径：session abort 时同步 abort fork
      const onSessionAbort = () => forkController?.abort();
      sessionSignal.addEventListener('abort', onSessionAbort, { once: true });
      return {
        signal: forkController.signal,
        cleanup: () => {
          if (timer) clearTimeout(timer);
          sessionSignal.removeEventListener('abort', onSessionAbort);
        },
      };
    }
    return {
      signal: forkController.signal,
      cleanup: () => { if (timer) clearTimeout(timer); },
    };
  } catch {
    return { signal: sessionSignal, cleanup: () => { if (timer) clearTimeout(timer); } };
  }
}

/**
 * 执行一次 fork 调用，自动管理 AbortController 生命周期与 in-flight 计数。
 * - 自动用 createForkAbortController 创建 per-fork signal
 * - finally 中清理 timer 并递减 inFlightForks
 */
export async function runFork<T>(
  state: CompressionSafetyState,
  forkTimeoutMs: number,
  fn: (signal: AbortSignal | undefined) => Promise<T>,
): Promise<T> {
  const { signal, cleanup } = createForkAbortController(state, forkTimeoutMs);
  state.inFlightForks++;
  try {
    return await fn(signal);
  } finally {
    cleanup();
    state.inFlightForks = Math.max(0, state.inFlightForks - 1);
  }
}

/** 取消整个 session（LRU 淘汰 / 用户主动中断时调用） */
export function abortSafetyState(state: CompressionSafetyState): void {
  state.sessionAbortController?.abort();
}

/** 该 session 是否有进行中的 fork（LRU 淘汰前检查） */
export function hasInFlightForks(state: CompressionSafetyState): boolean {
  return state.inFlightForks > 0;
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
   * 修复 P0#3：旧实现只校验"tool_result 的 dep 被引用"，不校验"assistant_message 的
   * toolCallId 依赖必须有 tool_result"，导致悬空 tool_call 漏检，模型重放时报错。
   *
   * 权威标记：`meta.toolCallId`（tool_call / tool_result 必有，assistant_message 可选）。
   * 回退标记：`dependencies`（在 assistant_message / tool_call 上按框架约定为 toolCallId；
   *   在 tool_result 上也为 toolCallId；详见 agentpack 的 messageToResource）。
   *
   * 检查规则（双向）：
   *  1. 每个 tool_result 的 toolCallId 必须有对应发起方（assistant_message 含该 ToolCallContent
   *     或 tool_call 资源）
   *  2. 每个 tool_call / assistant_message.toolCallId 依赖必须有对应 tool_result
   *  3. resource.meta.toolCallId 与 dependencies 不一致时以 meta 为准
   */
  validateToolPairing(resources: ContextResource[]): boolean {
    // 收集所有 toolCallId（以 meta.toolCallId 为权威，无则取 dependencies）
    const initiatorCallIds = new Set<string>();   // assistant_message 发起 + tool_call
    const resultCallIds = new Set<string>();      // tool_result

    for (const r of resources) {
      const metaCallId = r.meta?.toolCallId as string | undefined;

      if (r.type === 'tool_result') {
        // 优先 meta.toolCallId；无则取 dependencies[0]（框架约定）
        const callId = metaCallId ?? r.dependencies[0];
        if (callId) resultCallIds.add(callId);
      } else if (r.type === 'tool_call') {
        const callId = metaCallId ?? r.dependencies[0] ?? r.id;
        if (callId) initiatorCallIds.add(callId);
      } else if (r.type === 'assistant_message') {
        // assistant_message 的 dependencies 在框架约定里就是 toolCallId（messageToResource
        // 中 builder.dependsOn(tc.id)）；同时支持从 content 提取 ToolCallContent.id。
        // 若框架设置了 meta.toolCallId 则以此为准（与 tool_call/tool_result 一致）。
        const metaCallId = r.meta?.toolCallId as string | undefined;
        if (metaCallId) initiatorCallIds.add(metaCallId);
        for (const dep of r.dependencies) initiatorCallIds.add(dep);
        const fromContent = extractToolCallIdsFromContent(r.content);
        for (const id of fromContent) initiatorCallIds.add(id);
      }
    }

    // 规则 1：每个 tool_result 必须有发起方
    for (const callId of resultCallIds) {
      if (!initiatorCallIds.has(callId)) return false;
    }

    // 规则 2：每个发起方 toolCallId 必须有 tool_result（否则悬空 tool_call）
    // 注：assistant_message 可能只有文本回复（dependencies 为空），无 toolCallId 时跳过
    for (const callId of initiatorCallIds) {
      if (!resultCallIds.has(callId)) return false;
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

/**
 * 从 assistant_message.content 中提取 ToolCallContent 的 id。
 * 自包含实现，不依赖 agentpack 内部辅助。
 */
function extractToolCallIdsFromContent(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const ids: string[] = [];
  for (const block of content) {
    if (block && typeof block === 'object') {
      const b = block as { type?: unknown; id?: unknown };
      if (b.type === 'toolCall' && typeof b.id === 'string') {
        ids.push(b.id);
      }
    }
  }
  return ids;
}
