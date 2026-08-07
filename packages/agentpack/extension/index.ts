/**
 * packages/extension - 扩展插件
 *
 * 独立实现的 Extension 系统，不依赖 src/。
 * 通过 Tapable 钩子在 Runtime 生命周期的关键节点注入逻辑。
 */

import { BaseExtension, ExtensionManager, isErrorToolResult } from '../core';
import type { Extension, RuntimeHooks, ExtensionContext } from '../core';
import type { Request, Result, ContextResource } from '../core';
import type {
  ToolCallContext,
  AfterToolCallContext,
  BeforeToolCallResult,
  AfterToolCallResult,
  BeforeToolCallDecision,
  AfterToolCallDecision,
} from '../core';

// ─── 日志扩展 ─────────────────────────────────────────────────────

/**
 * 在 Runtime 生命周期关键节点输出日志。
 */
export class LoggingExtension extends BaseExtension {
  readonly name = 'logging';

  constructor(private verbose: boolean = false) {
    super();
  }

  protected setup(hooks: RuntimeHooks, _context: ExtensionContext): void {
    hooks.beforeInitialize.tapPromise('logging', async (request) => {
      console.log(`[Runtime] 初始化: ${request.message.substring(0, 80)}`);
    });

    hooks.beforeRun.tapPromise('logging', async (request) => {
      if (this.verbose) {
        console.debug(`[Runtime] 请求处理:`, { session: request.sessionKey });
      }
      return request;
    });

    hooks.done.tapPromise('logging', async (result) => {
      console.log(`[Runtime] 完成: tools=${result.toolsUsed.join(',')}, reason=${result.stopReason}`);
    });

    hooks.failed.tapPromise('logging', async (error, request) => {
      console.error(`[Runtime] 失败: ${error.message}`);
    });
  }
}

// ─── 事件捕获扩展 ─────────────────────────────────────────────────

/**
 * 捕获所有 Runtime 事件，用于调试和监控。
 * 事件数组有上限（默认 1000），超出后丢弃最旧，防止长生命周期进程内存泄漏。
 */
export class EventCaptureExtension extends BaseExtension {
  readonly name = 'event-capture';
  private events: Array<{ hook: string; timestamp: number; data?: unknown }> = [];
  private maxEvents: number;

  constructor(maxEvents: number = 1000) {
    super();
    this.maxEvents = Math.max(1, maxEvents);
  }

  protected setup(hooks: RuntimeHooks, _context: ExtensionContext): void {
    const captureSeries = (hookName: string) => {
      return async (...args: any[]) => {
        this.push({
          hook: hookName,
          timestamp: Date.now(),
          data: args.length === 1 ? args[0] : args,
        });
      };
    };

    const captureWaterfall = (hookName: string) => {
      return async (value: any, ...rest: any[]) => {
        this.push({
          hook: hookName,
          timestamp: Date.now(),
          data: rest.length > 0 ? [value, ...rest] : value,
        });
        return value;
      };
    };

    hooks.beforeInitialize.tapPromise('event-capture', captureSeries('beforeInitialize'));
    hooks.afterInitialize.tapPromise('event-capture', captureSeries('afterInitialize'));
    hooks.beforeRun.tapPromise('event-capture', captureWaterfall('beforeRun'));
    hooks.beforeTransform.tapPromise('event-capture', captureWaterfall('beforeTransform'));
    hooks.afterTransform.tapPromise('event-capture', captureWaterfall('afterTransform'));
    hooks.beforeEmit.tapPromise('event-capture', captureSeries('beforeEmit'));
    hooks.afterEmit.tapPromise('event-capture', captureSeries('afterEmit'));
    hooks.done.tapPromise('event-capture', captureSeries('done'));
    hooks.failed.tapPromise('event-capture', captureSeries('failed'));
  }

  private push(event: { hook: string; timestamp: number; data?: unknown }): void {
    this.events.push(event);
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }
  }

  getEvents(): Array<{ hook: string; timestamp: number; data?: unknown }> {
    return [...this.events];
  }

  clearEvents(): void {
    this.events = [];
  }
}

// ─── 请求拦截扩展 ─────────────────────────────────────────────────

/**
 * 请求拦截扩展，可在 beforeRun 阶段修改请求。
 * 例如：添加系统前缀、过滤敏感信息等。
 */
export class RequestInterceptorExtension extends BaseExtension {
  readonly name = 'request-interceptor';

  constructor(private interceptor: (request: Request) => Promise<Request>) {
    super();
  }

  protected setup(hooks: RuntimeHooks, _context: ExtensionContext): void {
    hooks.beforeRun.tapPromise('request-interceptor', async (request) => {
      return this.interceptor(request);
    });
  }
}

// ─── 结果后处理扩展 ───────────────────────────────────────────────

/**
 * 结果后处理扩展，可在 done 阶段处理结果。
 * 例如：记录用量、发送通知等。
 */
export class ResultPostProcessorExtension extends BaseExtension {
  readonly name = 'result-post-processor';

  constructor(private processor: (result: Result) => Promise<void>) {
    super();
  }

  protected setup(hooks: RuntimeHooks, _context: ExtensionContext): void {
    hooks.done.tapPromise('result-post-processor', async (result) => {
      await this.processor(result);
    });
  }
}

// ─── 共享状态扩展 ─────────────────────────────────────────────────

/**
 * 提供会话级共享状态，允许不同 Extension 之间通信。
 */
export class SharedStateExtension extends BaseExtension {
  readonly name = 'shared-state';

  constructor(private state: Map<string, unknown> = new Map()) {
    super();
  }

  protected setup(hooks: RuntimeHooks, context: ExtensionContext): void {
    // 将共享状态注入到 ExtensionContext
    for (const [key, value] of this.state) {
      context.shared.set(key, value);
    }

    hooks.done.tapPromise('shared-state', async (result) => {
      // 从共享状态中读取数据
      const data = context.shared.get('result_data');
      if (data) {
        (result as any).metadata.sharedState = data;
      }
    });
  }

  set(key: string, value: unknown): this {
    this.state.set(key, value);
    return this;
  }

  get(key: string): unknown {
    return this.state.get(key);
  }
}

// ─── 扩展工厂 ─────────────────────────────────────────────────────

export function createDefaultExtensions(options?: {
  verbose?: boolean;
}): Extension[] {
  return [
    new LoggingExtension(options?.verbose ?? false),
  ];
}

export function createExtensionManager(options?: {
  verbose?: boolean;
  extensions?: Extension[];
}): ExtensionManager {
  const manager = new ExtensionManager();
  const defaults = createDefaultExtensions(options);
  manager.registerAll(defaults);

  if (options?.extensions) {
    manager.registerAll(options.extensions);
  }

  return manager;
}

// ─── 工具钩子扩展工厂 ─────────────────────────────────────────────

/**
 * 以对象式 API 注册 beforeToolCall / afterToolCall 回调，翻译为 waterfall tap。
 *
 * beforeToolCall：参数校验后、执行前。返回 { block, terminate, reason, args }：
 *  - block:true     该工具不执行，生成拒绝结果（[blocked] reason）
 *  - terminate:true 终止整个 run（本轮工具结束后停止 runLoop）
 *  - args           覆盖参数（仅当未 block）
 *
 * afterToolCall：执行后、事件发出前。返回 { terminate, result, details }：
 *  - terminate:true 终止整个 run
 *  - result         替换工具结果（waterfall，后续 tap 基于新结果继续）
 *  - details        浅合并到 result.details（result 优先）
 *
 * 多个 createToolHookExtension 串联时，任一设 block/terminate 即生效；
 * 前置 tap 已 block/terminate 时，后续 beforeToolCall 回调不再被调用。
 */
export function createToolHookExtension(options: {
  name?: string;
  beforeToolCall?: (
    ctx: ToolCallContext,
  ) => Promise<BeforeToolCallResult | void> | BeforeToolCallResult | void;
  afterToolCall?: (
    ctx: AfterToolCallContext,
  ) => Promise<AfterToolCallResult | void> | AfterToolCallResult | void;
}): Extension {
  const name = options.name ?? 'tool-hooks';
  return {
    name,
    apply(hooks: RuntimeHooks): void {
      if (options.beforeToolCall) {
        hooks.beforeToolCall.tapPromise(
          name,
          async (decision: BeforeToolCallDecision, ctx: ToolCallContext): Promise<BeforeToolCallDecision> => {
            // 前置 tap 已拒绝/终止：尊重其决策，不再调用用户回调
            if (decision.block || decision.terminate) return decision;
            const r = await options.beforeToolCall!(ctx);
            if (!r) return decision;
            return {
              block: r.block ?? decision.block,
              terminate: r.terminate ?? decision.terminate,
              reason: r.reason ?? decision.reason,
              args: r.args ?? decision.args,
            };
          },
        );
      }
      if (options.afterToolCall) {
        hooks.afterToolCall.tapPromise(
          name,
          async (decision: AfterToolCallDecision, ctx: ToolCallContext): Promise<AfterToolCallDecision> => {
            const isError = isErrorToolResult(decision.result);
            const r = await options.afterToolCall!({
              ...ctx,
              result: decision.result,
              isError,
            });
            if (!r) return decision;
            let result = decision.result;
            if (r.result) {
              result = r.result;
            } else if (r.details) {
              const base =
                result.details && typeof result.details === 'object'
                  ? (result.details as Record<string, unknown>)
                  : {};
              result = { ...result, details: { ...base, ...r.details } };
            }
            return {
              result,
              terminate: r.terminate ?? decision.terminate,
            };
          },
        );
      }
    },
  };
}
