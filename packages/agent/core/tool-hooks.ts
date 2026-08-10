/**
 * Tool Hooks - 工具调用钩子
 *
 * 在工具执行前后插入可拦截的决策点：
 * - beforeToolCall：参数校验后、执行前。可阻断（block）、终止整个 run（terminate）、改写参数。
 * - afterToolCall：执行后、最终事件发出前。可改写结果、终止整个 run。
 *
 * 通过 RuntimeHooks 暴露为 AsyncSeriesWaterfallHook，流转 decision 对象：
 * 多个 Extension 注册同一钩子时全部串行执行，任一设 block/terminate 即生效，
 * 后续 tap 可通过 decision.block / decision.terminate 自行 early-return。
 */

import type { Tool, ToolCallContent, ToolResult } from './types';
import type { Request } from './request';

// ─── 工具调用上下文 ───────────────────────────────────────────────

/** beforeToolCall / afterToolCall 共用的调用上下文 */
export interface ToolCallContext {
  /** 触发本次调用的工具调用块 */
  readonly toolCall: ToolCallContent;
  /** 即将执行（或已执行）的工具定义 */
  readonly tool: Tool;
  /** 经 prepareArguments 处理后的参数（afterToolCall 看到的是 beforeToolCall 改写后的值） */
  readonly args: unknown;
  /** 会话标识 */
  readonly sessionKey: string;
  /** 本次 run 的请求 */
  readonly request: Request;
  /** Runtime 级共享状态（Extension 间通信） */
  readonly shared: Map<string, unknown>;
  /** 中止信号（已桥接超时） */
  readonly signal: AbortSignal;
}

/** afterToolCall 上下文：在 ToolCallContext 基础上携带执行结果 */
export interface AfterToolCallContext extends ToolCallContext {
  /** 工具执行结果（可能已被前序 tap 改写） */
  readonly result: ToolResult;
  /** 结果是否为错误（details.error 存在） */
  readonly isError: boolean;
}

// ─── 用户返回值（部分字段，由框架合并） ───────────────────────────

/** beforeToolCall 回调返回值 */
export interface BeforeToolCallResult {
  /** 阻止该工具执行，生成拒绝结果代替真实执行 */
  block?: boolean;
  /** 终止整个 run（不仅该工具，runLoop 在本轮工具结束后停止） */
  terminate?: boolean;
  /** 阻止/终止原因，写入 ToolResult.content 与日志 */
  reason?: string;
  /** 覆盖参数（仅当未 block 时生效） */
  args?: unknown;
}

/** afterToolCall 回调返回值 */
export interface AfterToolCallResult {
  /** 终止整个 run */
  terminate?: boolean;
  /** 替换工具结果（waterfall：后续 tap 基于新结果继续） */
  result?: ToolResult;
  /** 便捷糖：浅合并到 result.details（与 result 互斥，result 优先） */
  details?: Record<string, unknown>;
}

// ─── 内部流转的 decision（waterfall 完整对象） ────────────────────

/** beforeToolCall waterfall 流转对象 */
export interface BeforeToolCallDecision {
  block: boolean;
  terminate: boolean;
  reason?: string;
  args: unknown;
}

/** afterToolCall waterfall 流转对象 */
export interface AfterToolCallDecision {
  result: ToolResult;
  terminate: boolean;
}

// ─── 辅助函数 ─────────────────────────────────────────────────────

/** 判断工具结果是否为错误（details.error 存在） */
export function isErrorToolResult(result: ToolResult): boolean {
  return !!(
    result.details &&
    typeof result.details === 'object' &&
    'error' in (result.details as object)
  );
}
