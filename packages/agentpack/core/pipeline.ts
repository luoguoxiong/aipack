/**
 * Pipeline - 转换流水线
 *
 * 灵感来自 webpack 的 Loader Runner。
 * Pipeline 按优先级顺序执行多个 ContextTransformer，
 * 每个 Transformer 接收前一个的输出作为输入，形成链式处理流水线。
 *
 * Webpack 映射: Loader Runner
 */

import type { ContextResource } from './context-resource';
import type { ContextTransformer, TransformContext } from './transformer';

// ─── Pipeline 接口 ────────────────────────────────────────────────

export interface Pipeline {
  /** 注册转换器 */
  use(transformer: ContextTransformer): this;
  /** 批量注册转换器 */
  useAll(transformers: ContextTransformer[]): this;
  /** 移除转换器 */
  remove(name: string): boolean;
  /** 获取所有已注册的转换器（按优先级排序） */
  getTransformers(): ContextTransformer[];
  /** 执行流水线 */
  run(resources: ContextResource[], context: TransformContext): Promise<ContextResource[]>;
  /** 清空流水线 */
  clear(): void;
  /** 流水线是否为空 */
  readonly isEmpty: boolean;
}

// ─── Pipeline 实现 ────────────────────────────────────────────────

export class PipelineImpl implements Pipeline {
  private transformers: ContextTransformer[] = [];

  get isEmpty(): boolean {
    return this.transformers.length === 0;
  }

  use(transformer: ContextTransformer): this {
    this.transformers.push(transformer);
    this.transformers.sort((a, b) => a.priority - b.priority);
    return this;
  }

  useAll(transformers: ContextTransformer[]): this {
    this.transformers.push(...transformers);
    this.transformers.sort((a, b) => a.priority - b.priority);
    return this;
  }

  remove(name: string): boolean {
    const idx = this.transformers.findIndex(t => t.name === name);
    if (idx === -1) return false;
    this.transformers.splice(idx, 1);
    return true;
  }

  getTransformers(): ContextTransformer[] {
    return [...this.transformers];
  }

  async run(
    resources: ContextResource[],
    context: TransformContext,
  ): Promise<ContextResource[]> {
    let current = resources;

    for (const transformer of this.transformers) {
      try {
        current = await transformer.transform(current, context);
      } catch (err) {
        // 单个 Transformer 失败时跳过，保持当前资源不变
        // 与 webpack Loader Runner 的容错策略一致
      }
    }

    return current;
  }

  clear(): void {
    this.transformers = [];
  }
}

// ─── 工厂函数 ─────────────────────────────────────────────────────

export function createPipeline(): Pipeline {
  return new PipelineImpl();
}
