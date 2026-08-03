/**
 * Transformer - 上下文转换器
 *
 * 灵感来自 webpack 的 Loader。
 * Transformer 负责在 Pipeline 中对 ContextResource 集合进行转换，
 * 例如压缩、清理、配对修复、状态快照注入等。
 *
 * Webpack 映射: Loader
 */

import type { ContextResource } from './context-resource';
import type { TaskGraph } from './task-graph';

// ─── 转换上下文 ───────────────────────────────────────────────────

export interface TransformContext {
  /** 当前任务图 */
  graph: TaskGraph;
  /** 运行时提供的额外上下文 */
  runtime: TransformRuntime;
  /** 中止信号 */
  signal?: AbortSignal;
}

export interface TransformRuntime {
  /** 会话标识 */
  sessionKey: string;
  /** 当前回合数 */
  turn: number;
  /** 工作区路径 */
  workspace?: string;
  /** 运行时配置 */
  config?: Record<string, unknown>;
}

// ─── 转换器接口 ───────────────────────────────────────────────────

export interface ContextTransformer {
  /** 转换器名称 */
  readonly name: string;
  /** 转换器优先级（数值越小越先执行） */
  readonly priority: number;
  /**
   * 执行转换
   * @param resources 输入资源列表
   * @param context 转换上下文
   * @returns 转换后的资源列表
   */
  transform(
    resources: ContextResource[],
    context: TransformContext,
  ): Promise<ContextResource[]>;
}

// ─── 转换器选项 ───────────────────────────────────────────────────

export interface TransformerOptions {
  /** 是否启用 */
  enabled?: boolean;
  /** 自定义优先级 */
  priority?: number;
  /** 额外配置 */
  config?: Record<string, unknown>;
}

// ─── 抽象基类 ─────────────────────────────────────────────────────

export abstract class BaseTransformer implements ContextTransformer {
  abstract readonly name: string;
  readonly priority: number;

  protected enabled: boolean;
  protected config: Record<string, unknown>;

  constructor(options: TransformerOptions = {}) {
    this.priority = options.priority ?? 100;
    this.enabled = options.enabled ?? true;
    this.config = options.config ?? {};
  }

  async transform(
    resources: ContextResource[],
    context: TransformContext,
  ): Promise<ContextResource[]> {
    if (!this.enabled) return resources;
    return this.run(resources, context);
  }

  protected abstract run(
    resources: ContextResource[],
    context: TransformContext,
  ): Promise<ContextResource[]>;
}
