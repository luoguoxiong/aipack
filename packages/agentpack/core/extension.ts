/**
 * Extension - 扩展插件系统
 *
 * Extension 通过 Tapable 钩子在 Runtime 生命周期的关键节点注入逻辑，
 * 无需修改 Runtime 核心，实现开闭原则。
 */

import { AsyncSeriesHook, AsyncSeriesWaterfallHook } from './tapable';
import type { Request } from './request';
import type { Result } from './result';
import type { ContextResource } from './context-resource';

// ─── Runtime 钩子集合 ─────────────────────────────────────────────

export interface RuntimeHooks {
  /** Runtime 初始化前 */
  beforeInitialize: AsyncSeriesHook<[Request]>;
  /** Runtime 初始化后 */
  afterInitialize: AsyncSeriesHook<[Request]>;
  /** 请求处理前（可修改请求） */
  beforeRun: AsyncSeriesWaterfallHook<Request>;
  /** 资源构建后、转换前（可修改资源） */
  beforeTransform: AsyncSeriesWaterfallHook<ContextResource[]>;
  /** 资源转换后、模型调用前（可修改资源） */
  afterTransform: AsyncSeriesWaterfallHook<ContextResource[]>;
  /** 模型调用后、结果构建前 */
  beforeEmit: AsyncSeriesHook<[Result]>;
  /** 结果构建后 */
  afterEmit: AsyncSeriesHook<[Result]>;
  /**
   * 运行结束。
   * 第二参数为最终 Request（可选，向后兼容）：done 钩子如需按会话配对（如记忆捕获），
   * 应使用 request.sessionKey 而非依赖 FIFO 推断。
   */
  done: AsyncSeriesHook<[Result, Request?]>;
  /** 运行失败 */
  failed: AsyncSeriesHook<[Error, Request]>;
}

// ─── Extension 接口 ───────────────────────────────────────────────

export interface Extension {
  /** 扩展名称 */
  readonly name: string;
  /**
   * 应用扩展到 Runtime
   * 通过 hooks.tap 注册回调
   */
  apply(hooks: RuntimeHooks, context: ExtensionContext): void;
}

// ─── 扩展上下文 ───────────────────────────────────────────────────

export interface ExtensionContext {
  /** Runtime 配置 */
  readonly config: Record<string, unknown>;
  /** 工作区路径 */
  readonly workspace: string;
  /** 会话标识 */
  readonly sessionKey: string;
  /** 共享状态（Extension 间通信） */
  readonly shared: Map<string, unknown>;
}

// ─── Extension 管理器 ─────────────────────────────────────────────

export class ExtensionManager {
  private extensions: Extension[] = [];
  private hooks: RuntimeHooks;

  constructor() {
    this.hooks = this.createHooks();
  }

  private createHooks(): RuntimeHooks {
    return {
      beforeInitialize: new AsyncSeriesHook('beforeInitialize'),
      afterInitialize: new AsyncSeriesHook('afterInitialize'),
      beforeRun: new AsyncSeriesWaterfallHook('beforeRun'),
      beforeTransform: new AsyncSeriesWaterfallHook('beforeTransform'),
      afterTransform: new AsyncSeriesWaterfallHook('afterTransform'),
      beforeEmit: new AsyncSeriesHook('beforeEmit'),
      afterEmit: new AsyncSeriesHook('afterEmit'),
      done: new AsyncSeriesHook('done'),
      failed: new AsyncSeriesHook('failed'),
    };
  }

  /** 注册扩展 */
  register(extension: Extension): this {
    this.extensions.push(extension);
    return this;
  }

  /** 批量注册扩展 */
  registerAll(extensions: Extension[]): this {
    for (const ext of extensions) {
      this.register(ext);
    }
    return this;
  }

  /** 应用所有扩展到钩子 */
  applyAll(context: ExtensionContext): void {
    for (const ext of this.extensions) {
      try {
        ext.apply(this.hooks, context);
      } catch (err) {
        // 单个 Extension 失败不影响其他 Extension，但需可观测
        console.warn(`[Extension] "${ext.name}" apply 失败:`, (err as Error)?.message ?? err);
      }
    }
  }

  /** 获取钩子集合 */
  getHooks(): RuntimeHooks {
    return this.hooks;
  }

  /** 移除扩展 */
  unregister(name: string): boolean {
    const idx = this.extensions.findIndex(e => e.name === name);
    if (idx === -1) return false;
    this.extensions.splice(idx, 1);
    return true;
  }

  /** 获取所有已注册的扩展 */
  getExtensions(): Extension[] {
    return [...this.extensions];
  }

  /** 清空所有扩展 */
  clear(): void {
    this.extensions = [];
  }
}

// ─── 抽象基类 ─────────────────────────────────────────────────────

export abstract class BaseExtension implements Extension {
  abstract readonly name: string;

  apply(hooks: RuntimeHooks, context: ExtensionContext): void {
    this.setup(hooks, context);
  }

  protected abstract setup(hooks: RuntimeHooks, context: ExtensionContext): void;
}
