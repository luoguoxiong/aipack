/**
 * Telemetry - 轻量可观测性接口
 *
 * 可选注入到 Runtime（RuntimeOptions.telemetry），用于观测：
 * - onRunEnd：一次 run() 完成（含耗时与最终 Result）
 * - onToolCall：单次工具执行（含耗时与 ToolResult）
 * - onModelCall：单次模型调用（含 token 用量与耗时）
 *
 * 设计原则：
 * - 全可选（未实现的方法静默跳过）
 * - 上报失败不影响主流程（内部吞错）
 * - 与 Extension 钩子正交：Telemetry 面向"观测"，Extension 面向"干预/注入"
 */

import type { Request, Result, ToolResult } from '../core';

/** run() 完成事件载荷 */
export interface RunTelemetryInfo {
  sessionKey: string;
  request: Request;
  durationMs: number;
  result: Result;
}

/** 单次工具执行事件载荷 */
export interface ToolTelemetryInfo {
  sessionKey: string;
  toolName: string;
  args: unknown;
  durationMs: number;
  result: ToolResult;
}

/** 单次模型调用事件载荷 */
export interface ModelTelemetryInfo {
  sessionKey: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

/** 工具调用被权限策略拒绝事件载荷 */
export interface PermissionDeniedTelemetryInfo {
  sessionKey: string;
  toolName: string;
  permissions: readonly string[];
  args: unknown;
  reason: string;
}

export interface Telemetry {
  /** 一次 run() 完成（成功或失败均触发） */
  onRunEnd?(info: RunTelemetryInfo): void | Promise<void>;
  /** 单次工具执行完成（含被 catch 的错误结果） */
  onToolCall?(info: ToolTelemetryInfo): void | Promise<void>;
  /** 单次模型调用完成（含流式正常结束与错误路径的累计用量） */
  onModelCall?(info: ModelTelemetryInfo): void | Promise<void>;
  /** 工具调用被 PermissionPolicy 拒绝（confirm 拒绝 / deny 决策均触发） */
  onPermissionDenied?(info: PermissionDeniedTelemetryInfo): void | Promise<void>;
}

/** 空实现（默认），便于组合 */
export function noopTelemetry(): Telemetry {
  return {};
}
