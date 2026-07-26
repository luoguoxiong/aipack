import { Type, Static, TSchema } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import { createToolResult, createToolError, isToolErrorResult } from "./types";
import { logger } from "../utils/logger";

export type { ToolContext, ToolDefinition } from "./types";
export type ToolResult<T = unknown> = AgentToolResult<T>;
export { createToolResult, createToolError, isToolErrorResult };

// 可重试的错误类型
const RETRYABLE_ERRORS = [
  'timeout', 'timed out', 'timeout exceeded',
  'connection reset', 'ECONNRESET', 'ENOTCONN',
  '429', 'rate limit', 'rate limited',
  '500', 'internal server error',
  '502', 'bad gateway',
  '503', 'service unavailable',
  '504', 'gateway timeout',
  'network error', 'connect econnrefused',
  'socket hang up', 'ETIMEDOUT',
];

// 不可重试的错误类型
const NON_RETRYABLE_ERRORS = [
  'permission', 'permissions', '403',
  '400', 'bad request', 'invalid parameter', 'parameter error',
  '401', 'unauthorized', 'authentication',
  '404', 'not found', 'ENOENT',
  'invalid json', 'json parse error',
];

export interface RetryConfig {
  maxRetries: number;
  initialDelay: number; // 毫秒
  backoffFactor: number;
}

export interface ToolHealth {
  name: string;
  health: 'good' | 'degraded' | 'bad';
  failureCount: number;
  lastFailureTime: number | null;
  consecutiveFailures: number;
  totalCalls: number;
  successRate: number;
}

export class ToolHealthManager {
  private healthMap: Map<string, ToolHealth> = new Map();
  private readonly MAX_CONSECUTIVE_FAILURES = 5;
  private readonly HEALTH_WINDOW_MS = 60000; // 1分钟窗口

  getHealth(toolName: string): ToolHealth {
    return this.healthMap.get(toolName) || {
      name: toolName,
      health: 'good',
      failureCount: 0,
      lastFailureTime: null,
      consecutiveFailures: 0,
      totalCalls: 0,
      successRate: 1,
    };
  }

  recordSuccess(toolName: string): void {
    const health = this.getHealth(toolName);
    health.totalCalls++;
    health.consecutiveFailures = 0;
    health.successRate = health.totalCalls > 0
      ? (health.totalCalls - health.failureCount) / health.totalCalls
      : 1;
    health.health = this.calculateHealth(health);
    this.healthMap.set(toolName, health);
  }

  recordFailure(toolName: string): void {
    const health = this.getHealth(toolName);
    health.totalCalls++;
    health.failureCount++;
    health.consecutiveFailures++;
    health.lastFailureTime = Date.now();
    health.successRate = health.totalCalls > 0
      ? (health.totalCalls - health.failureCount) / health.totalCalls
      : 0;
    health.health = this.calculateHealth(health);
    this.healthMap.set(toolName, health);
  }

  private calculateHealth(health: ToolHealth): 'good' | 'degraded' | 'bad' {
    if (health.consecutiveFailures >= this.MAX_CONSECUTIVE_FAILURES) {
      return 'bad';
    }
    if (health.successRate < 0.5) {
      return 'degraded';
    }
    return 'good';
  }

  isHealthy(toolName: string): boolean {
    const health = this.getHealth(toolName);
    // 如果最近失败过且在冷却期内，视为不健康
    if (health.lastFailureTime && 
        Date.now() - health.lastFailureTime < this.HEALTH_WINDOW_MS) {
      return health.health !== 'bad';
    }
    return true;
  }

  getUnhealthyTools(): string[] {
    return Array.from(this.healthMap.entries())
      .filter(([, health]) => health.health === 'bad')
      .map(([name]) => name);
  }

  resetHealth(toolName: string): void {
    this.healthMap.delete(toolName);
  }

  resetAll(): void {
    this.healthMap.clear();
  }
}

export const toolHealthManager = new ToolHealthManager();

export abstract class BaseTool<TParameters extends TSchema = TSchema> {
  abstract name: string;
  abstract label: string;
  abstract description: string;
  abstract parameters: TParameters;
  
  retryConfig: RetryConfig = {
    maxRetries: 3,
    initialDelay: 1000,
    backoffFactor: 2,
  };

  validateArguments(args: unknown): Static<TParameters> {
    return args as Static<TParameters>;
  }

  async execute(
    toolCallId: string,
    params: Static<TParameters>,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<unknown>,
  ): Promise<AgentToolResult<unknown>> {
    throw new Error('必须实现 execute() 方法');
  }

  private isRetryableError(errorMessage: string): boolean {
    const lower = errorMessage.toLowerCase();
    return RETRYABLE_ERRORS.some(err => lower.includes(err));
  }

  private isNonRetryableError(errorMessage: string): boolean {
    const lower = errorMessage.toLowerCase();
    return NON_RETRYABLE_ERRORS.some(err => lower.includes(err));
  }

  private async delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async safeExecute(
    toolCallId: string,
    params: Static<TParameters>,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<unknown>,
  ): Promise<AgentToolResult<unknown>> {
    let lastError: Error | null = null;
    
    for (let attempt = 0; attempt <= this.retryConfig.maxRetries; attempt++) {
      try {
        const result = await this.execute(toolCallId, params, signal, onUpdate);
        
        // 记录成功
        toolHealthManager.recordSuccess(this.name);
        
        return result;
      } catch (err) {
        lastError = err as Error;
        const errorMessage = lastError.message;
        
        // 记录失败
        toolHealthManager.recordFailure(this.name);
        
        // 检查是否需要重试
        if (!this.isRetryableError(errorMessage) || this.isNonRetryableError(errorMessage)) {
          logger.warn(
            { toolName: this.name, toolCallId, attempt, error: errorMessage },
            '工具执行失败（不可重试）'
          );
          break;
        }
        
        // 如果达到最大重试次数，不再重试
        if (attempt >= this.retryConfig.maxRetries) {
          logger.error(
            { toolName: this.name, toolCallId, attempt: attempt + 1, error: errorMessage },
            '工具在最大重试次数后执行失败'
          );
          break;
        }
        
        // 指数退避
        const delayMs = this.retryConfig.initialDelay * 
          Math.pow(this.retryConfig.backoffFactor, attempt);
        
        logger.warn(
          { toolName: this.name, toolCallId, attempt: attempt + 1, 
            maxRetries: this.retryConfig.maxRetries, delayMs, error: errorMessage },
          '正在重试工具执行'
        );
        
        // 检查是否被取消
        if (signal?.aborted) {
          logger.info({ toolName: this.name, toolCallId }, '工具执行已取消');
          break;
        }
        
        await this.delay(delayMs);
      }
    }
    
    // 返回友好的错误消息
    if (lastError) {
      return this.createFriendlyError(lastError.message);
    }
    
    return createToolError('发生未知错误');
  }

  private createFriendlyError(errorMessage: string): AgentToolResult<unknown> {
    logger.error(
      { toolName: this.name, error: errorMessage },
      '工具执行失败'
    );
    
    let friendlyMessage = this.summarizeError(errorMessage);
    return createToolError(friendlyMessage);
  }

  summarizeError(errorMessage: string): string {
    const lower = errorMessage.toLowerCase();
    
    if (lower.includes('permission') || lower.includes('403')) {
      return `权限被拒绝：此工具需要更高的权限。请检查文件权限或以适当的权限运行。`;
    }
    
    if (lower.includes('enoent') || lower.includes('not found') || lower.includes('404')) {
      return `文件未找到：指定的路径不存在。请验证路径后重试。`;
    }
    
    if (lower.includes('timeout') || lower.includes('504')) {
      return `操作超时：工具执行时间过长。这通常是由于网络问题或服务器过载造成的。`;
    }
    
    if (lower.includes('429') || lower.includes('rate limit')) {
      return `请求频率限制：短时间内请求过多。请稍候再试。`;
    }
    
    if (lower.includes('500') || lower.includes('502') || lower.includes('503')) {
      return `服务不可用：远程服务暂时宕机。请稍后重试。`;
    }
    
    if (lower.includes('network') || lower.includes('connect') || lower.includes('dns')) {
      return `网络错误：无法连接到远程服务。请检查您的网络连接。`;
    }
    
    if (lower.includes('invalid') || lower.includes('bad request') || lower.includes('400')) {
      return `参数无效：提供的参数不正确。请查看工具文档并使用有效参数重试。`;
    }
    
    return `工具执行失败：${errorMessage}`;
  }

  prepareArguments?(args: unknown): Static<TParameters> {
    return this.validateArguments(args);
  }

  getDefinition(): { name: string; description: string; parameters: TParameters } {
    return {
      name: this.name,
      description: this.description,
      parameters: this.parameters,
    };
  }

  toAgentTool(): AgentTool<TParameters> {
    return {
      name: this.name,
      label: this.label,
      description: this.description,
      parameters: this.parameters,
      execute: (toolCallId, params, signal, onUpdate) => this.safeExecute(toolCallId, params, signal, onUpdate),
      prepareArguments: this.prepareArguments?.bind(this),
    };
  }
}
