/**
 * pipeline 模块测试：createDefaultPipeline / PipelineRunner / createPipelineRunner
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDefaultPipeline,
  PipelineRunner,
  createPipelineRunner,
} from '../pipeline/index.ts';
import type { ContextResource, TransformContext, ContextTransformer } from '../core/index.ts';
import { createTaskGraph, BaseTransformer } from '../core/index.ts';

function ctx(): TransformContext {
  return {
    graph: createTaskGraph(),
    runtime: { sessionKey: 's', turn: 0, contextWindow: 128000 },
  };
}

// ─── createDefaultPipeline ─────────────────────────────────────────

describe('createDefaultPipeline', () => {
  it('包含内置转换器', () => {
    const pipeline = createDefaultPipeline();
    const names = pipeline.getTransformers().map(t => t.name);
    assert.ok(names.includes('system-message-cleaner'));
    assert.ok(names.includes('truncation'));
    assert.ok(names.includes('token-budget'));
    assert.ok(names.includes('tool-pairing'));
  });

  it('注册额外转换器', () => {
    const extra: ContextTransformer = {
      name: 'extra',
      priority: 200,
      transform: async (r) => r,
    };
    const pipeline = createDefaultPipeline({ extraTransformers: [extra] });
    const names = pipeline.getTransformers().map(t => t.name);
    assert.ok(names.includes('extra'));
  });

  it('支持 getStateSnapshot', () => {
    const pipeline = createDefaultPipeline({
      getStateSnapshot: () => 'snapshot content',
    });
    const names = pipeline.getTransformers().map(t => t.name);
    assert.ok(names.includes('state-snapshot'));
  });

  it('支持 maxResources 配置', () => {
    const pipeline = createDefaultPipeline({ maxResources: 10 });
    assert.equal(pipeline.isEmpty, false);
  });
});

// ─── PipelineRunner ────────────────────────────────────────────────

describe('PipelineRunner', () => {
  it('use 注册转换器', () => {
    const runner = new PipelineRunner();
    const t: ContextTransformer = {
      name: 'test',
      priority: 50,
      transform: async (r) => r,
    };
    runner.use(t);
    assert.equal(runner.getTransformers().length, 1);
  });

  it('useAll 批量注册', () => {
    const runner = new PipelineRunner();
    runner.useAll([
      { name: 'a', priority: 10, transform: async (r: ContextResource[]) => r },
      { name: 'b', priority: 20, transform: async (r: ContextResource[]) => r },
    ]);
    assert.equal(runner.getTransformers().length, 2);
  });

  it('run 执行流水线并返回结果', async () => {
    const runner = new PipelineRunner();
    runner.use({
      name: 'noop',
      priority: 50,
      transform: async (r) => r,
    });
    const input: ContextResource[] = [];
    const result = await runner.run(input, ctx());
    assert.deepEqual(result, input);
  });

  it('runCount 统计执行次数', async () => {
    const runner = new PipelineRunner();
    await runner.run([], ctx());
    await runner.run([], ctx());
    const stats = runner.getStats();
    assert.equal(stats.runCount, 2);
  });

  it('totalTransformations 统计资源数量变化的次数', async () => {
    const runner = new PipelineRunner();
    class AddOne extends BaseTransformer {
      readonly name = 'add-one';
      constructor() { super({ priority: 50 }); }
      protected async run(resources: ContextResource[]): Promise<ContextResource[]> {
        return [...resources, { id: `r${resources.length}`, type: 'custom', role: 'user', content: '', timestamp: 0, dependencies: [], meta: {}, pinned: false }];
      }
    }
    runner.use(new AddOne());
    await runner.run([], ctx());
    const stats = runner.getStats();
    assert.equal(stats.totalTransformations, 1);
  });

  it('资源数量不变时不计入 totalTransformations', async () => {
    const runner = new PipelineRunner();
    runner.use({
      name: 'noop',
      priority: 50,
      transform: async (r) => r,
    });
    const input: ContextResource[] = [
      { id: 'r0', type: 'custom', role: 'user', content: '', timestamp: 0, dependencies: [], meta: {}, pinned: false },
    ];
    await runner.run(input, ctx());
    const stats = runner.getStats();
    assert.equal(stats.totalTransformations, 0);
  });

  it('getStats 返回 transformerCount', () => {
    const runner = new PipelineRunner();
    runner.use({ name: 'a', priority: 10, transform: async (r: ContextResource[]) => r });
    runner.use({ name: 'b', priority: 20, transform: async (r: ContextResource[]) => r });
    const stats = runner.getStats();
    assert.equal(stats.transformerCount, 2);
  });

  it('getPipeline 返回底层 Pipeline', () => {
    const runner = new PipelineRunner();
    const pipeline = runner.getPipeline();
    assert.ok(pipeline);
    assert.equal(pipeline.isEmpty, true);
  });

  it('构造时传入自定义 Pipeline', () => {
    const custom = createDefaultPipeline();
    const runner = new PipelineRunner(custom);
    assert.equal(runner.getPipeline(), custom);
  });
});

// ─── createPipelineRunner ──────────────────────────────────────────

describe('createPipelineRunner', () => {
  it('返回带默认转换器的 PipelineRunner', () => {
    const runner = createPipelineRunner();
    assert.ok(runner instanceof PipelineRunner);
    const stats = runner.getStats();
    assert.ok(stats.transformerCount > 0);
  });

  it('支持 options 透传', () => {
    const runner = createPipelineRunner({
      maxResources: 5,
      extraTransformers: [{ name: 'extra', priority: 200, transform: async (r: ContextResource[]) => r }],
    });
    const names = runner.getTransformers().map(t => t.name);
    assert.ok(names.includes('extra'));
  });
});
