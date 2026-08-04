/**
 * packages/extension - 扩展插件
 *
 * 独立实现的 Extension 系统，不依赖 src/。
 * 通过 Tapable 钩子在 Runtime 生命周期的关键节点注入逻辑。
 */

import { BaseExtension, ExtensionManager } from '../core';
import type { Extension, RuntimeHooks, ExtensionContext } from '../core';
import type { Request, Result, ContextResource } from '../core';

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
