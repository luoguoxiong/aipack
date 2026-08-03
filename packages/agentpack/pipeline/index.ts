/**
 * packages/pipeline - 转换流水线
 *
 * 独立实现，不依赖 src/。
 * Pipeline 按 Transformer 优先级顺序执行，形成链式处理流水线。
 */

import {
  createPipeline,
  PipelineImpl,
} from '../core';
import type { Pipeline, ContextTransformer, ContextResource, TransformContext } from '../core';
import { createDefaultTransformers } from '../transformer';

// ─── 流水线工厂 ───────────────────────────────────────────────────

/**
 * 创建默认流水线，包含内置转换器
 */
export function createDefaultPipeline(options?: {
  getStateSnapshot?: () => string | null;
  maxResources?: number;
  extraTransformers?: ContextTransformer[];
}): Pipeline {
  const pipeline = createPipeline();

  // 注册内置转换器
  const builtins = createDefaultTransformers({
    getStateSnapshot: options?.getStateSnapshot,
    maxResources: options?.maxResources,
  });
  pipeline.useAll(builtins);

  // 注册额外转换器
  if (options?.extraTransformers) {
    pipeline.useAll(options.extraTransformers);
  }

  return pipeline;
}

// ─── 流水线运行器 ─────────────────────────────────────────────────

/**
 * PipelineRunner 封装了 Pipeline 的执行逻辑，
 * 提供便捷的运行接口和执行统计。
 */
export class PipelineRunner {
  private pipeline: Pipeline;
  private runCount = 0;
  private totalTransformations = 0;

  constructor(pipeline?: Pipeline) {
    this.pipeline = pipeline ?? createPipeline();
  }

  /** 注册转换器 */
  use(transformer: ContextTransformer): this {
    this.pipeline.use(transformer);
    return this;
  }

  /** 批量注册转换器 */
  useAll(transformers: ContextTransformer[]): this {
    this.pipeline.useAll(transformers);
    return this;
  }

  /** 执行流水线 */
  async run(
    resources: ContextResource[],
    context: TransformContext,
  ): Promise<ContextResource[]> {
    const beforeCount = resources.length;
    const result = await this.pipeline.run(resources, context);
    const afterCount = result.length;

    this.runCount++;
    if (beforeCount !== afterCount) {
      this.totalTransformations++;
    }

    return result;
  }

  /** 获取转换器列表 */
  getTransformers(): ContextTransformer[] {
    return this.pipeline.getTransformers();
  }

  /** 获取执行统计 */
  getStats(): {
    runCount: number;
    totalTransformations: number;
    transformerCount: number;
  } {
    return {
      runCount: this.runCount,
      totalTransformations: this.totalTransformations,
      transformerCount: this.pipeline.getTransformers().length,
    };
  }

  /** 获取底层 Pipeline */
  getPipeline(): Pipeline {
    return this.pipeline;
  }
}

// ─── 便捷工厂 ─────────────────────────────────────────────────────

export function createPipelineRunner(options?: {
  getStateSnapshot?: () => string | null;
  maxResources?: number;
  extraTransformers?: ContextTransformer[];
}): PipelineRunner {
  const pipeline = createDefaultPipeline(options);
  return new PipelineRunner(pipeline);
}
