/**
 * Core 层测试：类型工具、Tapable 钩子、ExtensionManager、Pipeline、TaskGraph、
 * ContextResource、Request、Result、BaseTransformer
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractText,
  extractToolCalls,
  createTextContent,
  createEmptyUsage,
  SyncHook,
  AsyncSeriesHook,
  AsyncSeriesWaterfallHook,
  HookMap,
  ExtensionManager,
  BaseExtension,
  createPipeline,
  PipelineImpl,
  TaskGraphImpl,
  createTaskGraph,
  TaskGraphBuilder,
  ContextResourceBuilder,
  createMessageResource,
  createToolCallResource,
  createToolResultResource,
  RequestBuilder,
  createRequest,
  ResultBuilder,
  createResult,
  createErrorResult,
  BaseTransformer,
} from '../core/index.ts';
import type {
  ContextResource,
  TransformContext,
  ContextTransformer,
  Extension,
  RuntimeHooks,
  ExtensionContext,
} from '../core/index.ts';
import { createTaskGraph as newGraph } from '../core/index.ts';

// ─── 工具函数 ───────────────────────────────────────────────────────

function ctx(): TransformContext {
  return {
    graph: newGraph(),
    runtime: { sessionKey: 's', turn: 0 },
  };
}

// ─── types.ts 工具函数 ─────────────────────────────────────────────

describe('extractText', () => {
  it('字符串原样返回', () => {
    assert.equal(extractText('hello'), 'hello');
  });

  it('从 ContentBlock[] 拼接 text 块', () => {
    const blocks = [
      createTextContent('a'),
      { type: 'image', data: 'x', mimeType: 'image/png' },
      createTextContent('b'),
    ];
    assert.equal(extractText(blocks), 'ab');
  });

  it('空数组返回空串', () => {
    assert.equal(extractText([]), '');
  });
});

describe('extractToolCalls', () => {
  it('字符串内容返回空数组', () => {
    assert.deepEqual(extractToolCalls('hi'), []);
  });

  it('提取所有 toolCall 块', () => {
    const blocks = [
      createTextContent('call tool'),
      { type: 'toolCall', id: 'tc1', name: 'foo', arguments: { x: 1 } },
      { type: 'toolCall', id: 'tc2', name: 'bar', arguments: {} },
    ];
    const calls = extractToolCalls(blocks);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].id, 'tc1');
    assert.equal(calls[1].name, 'bar');
  });
});

describe('createEmptyUsage', () => {
  it('返回零值 usage', () => {
    const u = createEmptyUsage();
    assert.equal(u.input, 0);
    assert.equal(u.output, 0);
    assert.equal(u.total, 0);
  });
});

// ─── Tapable 钩子 ──────────────────────────────────────────────────

describe('SyncHook', () => {
  it('按 stage 顺序执行', () => {
    const hook = new SyncHook<[number]>();
    const order: number[] = [];
    hook.tap('a', () => order.push(1), 10);
    hook.tap('b', () => order.push(2), 5);
    hook.tap('c', () => order.push(3), 20);
    hook.call(0);
    assert.deepEqual(order, [2, 1, 3]);
  });

  it('单个 tap 抛错不影响其他 tap', () => {
    const hook = new SyncHook();
    let called = false;
    hook.tap('throw', () => { throw new Error('boom'); });
    hook.tap('ok', () => { called = true; });
    hook.call();
    assert.equal(called, true);
  });

  it('isUsed / clear', () => {
    const hook = new SyncHook();
    assert.equal(hook.isUsed(), false);
    hook.tap('x', () => {});
    assert.equal(hook.isUsed(), true);
    hook.clear();
    assert.equal(hook.isUsed(), false);
  });
});

describe('AsyncSeriesHook', () => {
  it('串行执行所有 tap', async () => {
    const hook = new AsyncSeriesHook<[string]>();
    const seen: string[] = [];
    hook.tapPromise('a', async (s) => { seen.push(s + '1'); });
    hook.tapPromise('b', async (s) => { seen.push(s + '2'); });
    await hook.promise('x');
    assert.deepEqual(seen, ['x1', 'x2']);
  });

  it('单个 tap reject 不影响其他 tap', async () => {
    const hook = new AsyncSeriesHook();
    let called = false;
    hook.tapPromise('throw', async () => { throw new Error('boom'); });
    hook.tapPromise('ok', async () => { called = true; });
    await hook.promise();
    assert.equal(called, true);
  });
});

describe('AsyncSeriesWaterfallHook', () => {
  it('每个 tap 接收上一个的返回值', async () => {
    const hook = new AsyncSeriesWaterfallHook<number>();
    hook.tapPromise('a', async (n) => n + 1);
    hook.tapPromise('b', async (n) => n * 2);
    const result = await hook.promise(10);
    assert.equal(result, 22); // (10 + 1) * 2
  });

  it('tap 抛错时保持当前值不变', async () => {
    const hook = new AsyncSeriesWaterfallHook<number>();
    hook.tapPromise('ok', async (n) => n + 1);
    hook.tapPromise('throw', async () => { throw new Error('boom'); });
    hook.tapPromise('ok2', async (n) => n + 1);
    const result = await hook.promise(10);
    assert.equal(result, 12); // 10 + 1 (throw 跳过) + 1
  });
});

describe('HookMap', () => {
  it('按 key 隔离 hook 实例', () => {
    const map = new HookMap<SyncHook>(() => new SyncHook());
    const h1 = map.for('a');
    const h2 = map.for('b');
    const h1Again = map.for('a');
    assert.equal(h1, h1Again, '相同 key 返回同一实例');
    assert.notEqual(h1, h2, '不同 key 返回不同实例');
    assert.equal(map.has('a'), true);
    assert.equal(map.has('c'), false);
    assert.deepEqual(map.keys().sort(), ['a', 'b']);
  });
});

// ─── ExtensionManager ──────────────────────────────────────────────

function makeExt(name: string): { ext: Extension; applied: () => boolean } {
  let applied = false;
  const ext: Extension = {
    name,
    apply: () => { applied = true; },
  };
  return { ext, applied: () => applied };
}

function makeExtCtx(): ExtensionContext {
  return {
    config: {},
    workspace: '/tmp',
    sessionKey: 'test',
    shared: new Map(),
  };
}

describe('ExtensionManager', () => {
  it('register / registerAll / getExtensions', () => {
    const mgr = new ExtensionManager();
    const { ext: a } = makeExt('a');
    const { ext: b } = makeExt('b');
    mgr.register(a);
    mgr.registerAll([b]);
    const exts = mgr.getExtensions();
    assert.equal(exts.length, 2);
    // getExtensions 返回拷贝
    exts.push({ name: 'c', apply: () => {} });
    assert.equal(mgr.getExtensions().length, 2);
  });

  it('unregister 按名称移除', () => {
    const mgr = new ExtensionManager();
    const { ext: a } = makeExt('a');
    mgr.register(a);
    assert.equal(mgr.unregister('a'), true);
    assert.equal(mgr.unregister('not-exist'), false);
    assert.equal(mgr.getExtensions().length, 0);
  });

  it('applyAll 应用所有扩展，单个失败不影响其他', () => {
    const mgr = new ExtensionManager();
    const { ext: ok, applied: okApplied } = makeExt('ok');
    const bad: Extension = {
      name: 'bad',
      apply: () => { throw new Error('boom'); },
    };
    mgr.register(bad);
    mgr.register(ok);
    mgr.applyAll(makeExtCtx());
    assert.equal(okApplied(), true, '失败的扩展不应阻止后续扩展应用');
  });

  it('clear 清空所有扩展', () => {
    const mgr = new ExtensionManager();
    mgr.register(makeExt('a').ext);
    mgr.clear();
    assert.equal(mgr.getExtensions().length, 0);
  });

  it('getHooks 返回完整钩子集合', () => {
    const mgr = new ExtensionManager();
    const hooks = mgr.getHooks();
    assert.ok(hooks.beforeInitialize);
    assert.ok(hooks.afterInitialize);
    assert.ok(hooks.beforeRun);
    assert.ok(hooks.beforeTransform);
    assert.ok(hooks.afterTransform);
    assert.ok(hooks.beforeEmit);
    assert.ok(hooks.afterEmit);
    assert.ok(hooks.done);
    assert.ok(hooks.failed);
  });
});

describe('BaseExtension', () => {
  it('apply 调用 setup', () => {
    let setupCalled = false;
    class TestExt extends BaseExtension {
      readonly name = 'test';
      protected setup(): void {
        setupCalled = true;
      }
    }
    const ext = new TestExt();
    ext.apply({} as RuntimeHooks, makeExtCtx());
    assert.equal(setupCalled, true);
  });
});

// ─── Pipeline ──────────────────────────────────────────────────────

class DoublerTransformer extends BaseTransformer {
  readonly name = 'doubler';
  constructor(priority = 50) {
    super({ priority });
  }
  protected async run(resources: ContextResource[]): Promise<ContextResource[]> {
    return [...resources, ...resources];
  }
}

class FailTransformer extends BaseTransformer {
  readonly name = 'fail';
  constructor(priority = 50) {
    super({ priority });
  }
  protected async run(): Promise<ContextResource[]> {
    throw new Error('transform fail');
  }
}

describe('PipelineImpl', () => {
  it('use 按 priority 排序', () => {
    const pipeline = new PipelineImpl();
    const t1 = new DoublerTransformer(100);
    const t2 = new DoublerTransformer(10);
    const t3 = new DoublerTransformer(50);
    pipeline.use(t1);
    pipeline.use(t2);
    pipeline.use(t3);
    const ts = pipeline.getTransformers();
    assert.equal(ts[0].priority, 10);
    assert.equal(ts[1].priority, 50);
    assert.equal(ts[2].priority, 100);
  });

  it('useAll 批量注册并排序', () => {
    const pipeline = new PipelineImpl();
    pipeline.useAll([
      new DoublerTransformer(100),
      new DoublerTransformer(10),
    ]);
    const ts = pipeline.getTransformers();
    assert.equal(ts.length, 2);
    assert.equal(ts[0].priority, 10);
  });

  it('remove 按名称移除', () => {
    const pipeline = new PipelineImpl();
    pipeline.use(new DoublerTransformer());
    assert.equal(pipeline.remove('doubler'), true);
    assert.equal(pipeline.remove('doubler'), false);
    assert.equal(pipeline.getTransformers().length, 0);
  });

  it('isEmpty / clear', () => {
    const pipeline = new PipelineImpl();
    assert.equal(pipeline.isEmpty, true);
    pipeline.use(new DoublerTransformer());
    assert.equal(pipeline.isEmpty, false);
    pipeline.clear();
    assert.equal(pipeline.isEmpty, true);
  });

  it('run 串联执行所有转换器', async () => {
    const pipeline = new PipelineImpl();
    pipeline.use(new DoublerTransformer(10));
    pipeline.use(new DoublerTransformer(20));
    const input = [createMessageResource('user', 'hi')];
    const result = await pipeline.run(input, ctx());
    assert.equal(result.length, 4); // 1 -> 2 -> 4
  });

  it('run 中单个转换器抛错时跳过并保留当前资源', async () => {
    const pipeline = new PipelineImpl();
    pipeline.use(new FailTransformer(10));
    pipeline.use(new DoublerTransformer(20));
    const input = [createMessageResource('user', 'hi')];
    const result = await pipeline.run(input, ctx());
    // 第一个失败被跳过，输入原样进入第二个，第二个翻倍
    assert.equal(result.length, 2);
  });

  it('getTransformers 返回拷贝', () => {
    const pipeline = new PipelineImpl();
    pipeline.use(new DoublerTransformer());
    const ts = pipeline.getTransformers();
    ts.pop();
    assert.equal(pipeline.getTransformers().length, 1);
  });

  it('createPipeline 工厂返回 PipelineImpl 实例', () => {
    const p = createPipeline();
    assert.ok(p instanceof PipelineImpl);
    assert.equal(p.isEmpty, true);
  });
});

// ─── TaskGraph ─────────────────────────────────────────────────────

describe('TaskGraphImpl', () => {
  it('add 添加资源并建立依赖', () => {
    const graph = new TaskGraphImpl();
    const a = createMessageResource('user', 'a');
    const b = createMessageResource('assistant', 'b');
    graph.add(a);
    graph.add(b);
    assert.equal(graph.size, 2);
    assert.equal(graph.resolve(a.id), a);
    assert.equal(graph.resolve('not-exist'), undefined);
  });

  it('add 已存在 id 时先移除旧节点', () => {
    const graph = new TaskGraphImpl();
    const a1 = new ContextResourceBuilder('dup').type('user_message').role('user').content('v1').build();
    const a2 = new ContextResourceBuilder('dup').type('user_message').role('user').content('v2').build();
    graph.add(a1);
    graph.add(a2);
    assert.equal(graph.size, 1);
    assert.equal(graph.resolve('dup'), a2);
  });

  it('addAll 批量添加并补充依赖', () => {
    const graph = new TaskGraphImpl();
    const a = createMessageResource('user', 'a');
    const b = new ContextResourceBuilder()
      .id('b')
      .type('assistant_message')
      .role('assistant')
      .content('b')
      .dependsOn(a.id)
      .build();
    graph.addAll([a, b]);
    assert.equal(graph.size, 2);
    const nodeB = graph.getNode('b');
    assert.ok(nodeB);
    assert.ok(nodeB!.dependencies.has(a.id));
    const nodeA = graph.getNode(a.id);
    assert.ok(nodeA!.dependents.has('b'));
  });

  it('remove 清理依赖关系', () => {
    const graph = new TaskGraphImpl();
    const a = new ContextResourceBuilder().id('a').type('user_message').role('user').content('a').build();
    const b = new ContextResourceBuilder().id('b').type('assistant_message').role('assistant').content('b').dependsOn('a').build();
    graph.addAll([a, b]);
    assert.equal(graph.remove('a'), true);
    assert.equal(graph.remove('not-exist'), false);
    assert.equal(graph.size, 1);
    assert.equal(graph.getNode('b')!.dependencies.has('a'), false);
  });

  it('getAll / getByType', () => {
    const graph = new TaskGraphImpl();
    graph.addAll([
      createMessageResource('user', 'u'),
      createMessageResource('assistant', 'a'),
      createMessageResource('user', 'u2'),
    ]);
    assert.equal(graph.getAll().length, 3);
    assert.equal(graph.getByType('user_message').length, 2);
    assert.equal(graph.getByType('assistant_message').length, 1);
  });

  it('topologicalSort 按依赖排序', () => {
    const graph = new TaskGraphImpl();
    const a = new ContextResourceBuilder().id('a').type('user_message').role('user').content('a').build();
    const b = new ContextResourceBuilder().id('b').type('assistant_message').role('assistant').content('b').dependsOn('a').build();
    const c = new ContextResourceBuilder().id('c').type('user_message').role('user').content('c').dependsOn('b').build();
    graph.addAll([c, b, a]); // 乱序添加
    const sorted = graph.topologicalSort();
    const ids = sorted.map(r => r.id);
    assert.deepEqual(ids, ['a', 'b', 'c']);
  });

  it('topologicalSort 处理循环依赖（跳过环）', () => {
    const graph = new TaskGraphImpl();
    const a = new ContextResourceBuilder().id('a').type('user_message').role('user').content('a').dependsOn('b').build();
    const b = new ContextResourceBuilder().id('b').type('user_message').role('user').content('b').dependsOn('a').build();
    graph.addAll([a, b]);
    const sorted = graph.topologicalSort();
    assert.equal(sorted.length, 2); // 不死循环
  });

  it('isReachable 检查可达性', () => {
    const graph = new TaskGraphImpl();
    const a = new ContextResourceBuilder().id('a').type('user_message').role('user').content('a').build();
    const b = new ContextResourceBuilder().id('b').type('assistant_message').role('assistant').content('b').dependsOn('a').build();
    graph.addAll([a, b]);
    assert.equal(graph.isReachable('b', 'a'), true);
    assert.equal(graph.isReachable('a', 'b'), false);
    assert.equal(graph.isReachable('a', 'a'), true);
  });

  it('getLeaves 返回无依赖的节点', () => {
    const graph = new TaskGraphImpl();
    const a = new ContextResourceBuilder().id('a').type('user_message').role('user').content('a').build();
    const b = new ContextResourceBuilder().id('b').type('assistant_message').role('assistant').content('b').dependsOn('a').build();
    graph.addAll([a, b]);
    const leaves = graph.getLeaves();
    assert.equal(leaves.length, 1);
    assert.equal(leaves[0].id, 'a');
  });

  it('getRoots 返回无被依赖的节点', () => {
    const graph = new TaskGraphImpl();
    const a = new ContextResourceBuilder().id('a').type('user_message').role('user').content('a').build();
    const b = new ContextResourceBuilder().id('b').type('assistant_message').role('assistant').content('b').dependsOn('a').build();
    graph.addAll([a, b]);
    const roots = graph.getRoots();
    assert.equal(roots.length, 1);
    assert.equal(roots[0].id, 'b');
  });

  it('clear 清空图', () => {
    const graph = new TaskGraphImpl();
    graph.add(createMessageResource('user', 'a'));
    graph.clear();
    assert.equal(graph.size, 0);
  });

  it('TaskGraphBuilder 链式构建', () => {
    const builder = new TaskGraphBuilder();
    const a = createMessageResource('user', 'a');
    const b = createMessageResource('user', 'b');
    const graph = builder.add(a).addAll([b]).build();
    assert.equal(graph.size, 2);
  });

  it('createTaskGraph 工厂', () => {
    const graph = createTaskGraph();
    assert.ok(graph instanceof TaskGraphImpl);
    assert.equal(graph.size, 0);
  });
});

// ─── ContextResource ───────────────────────────────────────────────

describe('ContextResourceBuilder', () => {
  it('链式构建并填充默认值', () => {
    const r = new ContextResourceBuilder('rid')
      .type('user_message')
      .role('user')
      .content('hi')
      .timestamp(1000)
      .dependsOn('dep1', 'dep2')
      .meta('k', 'v')
      .pinned()
      .build();
    assert.equal(r.id, 'rid');
    assert.equal(r.type, 'user_message');
    assert.equal(r.role, 'user');
    assert.equal(r.content, 'hi');
    assert.equal(r.timestamp, 1000);
    assert.deepEqual(r.dependencies, ['dep1', 'dep2']);
    assert.equal(r.meta.k, 'v');
    assert.equal(r.pinned, true);
  });

  it('未传 id 时自动生成', () => {
    const r = new ContextResourceBuilder().build();
    assert.ok(r.id.startsWith('res_'));
  });

  it('pinned() 无参默认 true', () => {
    const r = new ContextResourceBuilder().pinned().build();
    assert.equal(r.pinned, true);
  });

  it('pinned(false) 取消固定', () => {
    const r = new ContextResourceBuilder().pinned(false).build();
    assert.equal(r.pinned, false);
  });
});

describe('createMessageResource', () => {
  it('user 角色映射 user_message', () => {
    const r = createMessageResource('user', 'hi');
    assert.equal(r.type, 'user_message');
    assert.equal(r.role, 'user');
  });

  it('assistant 角色映射 assistant_message', () => {
    const r = createMessageResource('assistant', 'hi');
    assert.equal(r.type, 'assistant_message');
  });

  it('system 角色映射 system_message', () => {
    const r = createMessageResource('system', 'sys');
    assert.equal(r.type, 'system_message');
  });

  it('其他角色映射 custom', () => {
    const r = createMessageResource('custom-role', 'x');
    assert.equal(r.type, 'custom');
  });

  it('支持 options 覆盖 timestamp', () => {
    const r = createMessageResource('user', 'hi', { timestamp: 42 });
    assert.equal(r.timestamp, 42);
  });
});

describe('createToolCallResource', () => {
  it('构建 tool_call 资源并填充 meta', () => {
    const r = createToolCallResource('tc1', 'get_weather', { city: '北京' });
    assert.equal(r.id, 'tc1');
    assert.equal(r.type, 'tool_call');
    assert.equal(r.role, 'assistant');
    assert.deepEqual(r.content, { toolName: 'get_weather', args: { city: '北京' } });
    assert.equal(r.meta.toolName, 'get_weather');
    assert.equal(r.meta.toolCallId, 'tc1');
  });
});

describe('createToolResultResource', () => {
  it('构建 tool_result 资源并声明依赖', () => {
    const r = createToolResultResource('tc1', 'get_weather', { temp: 20 }, false, 'tc1');
    assert.equal(r.id, 'tc1_result');
    assert.equal(r.type, 'tool_result');
    assert.equal(r.role, 'toolResult');
    assert.deepEqual(r.dependencies, ['tc1']);
    assert.equal(r.meta.isError, false);
  });
});

// ─── Request ───────────────────────────────────────────────────────

describe('RequestBuilder', () => {
  it('链式构建完整请求', () => {
    const req = new RequestBuilder()
      .message('hello')
      .type('stream')
      .channel('web')
      .chatId('c1')
      .senderId('u1')
      .media(['data:image/png;base64,xxx'])
      .ephemeral(true)
      .model('gpt-4o')
      .modelPreset('default')
      .metadata('k', 'v')
      .build();
    assert.equal(req.message, 'hello');
    assert.equal(req.type, 'stream');
    assert.equal(req.channel, 'web');
    assert.equal(req.chatId, 'c1');
    assert.equal(req.senderId, 'u1');
    assert.deepEqual(req.media, ['data:image/png;base64,xxx']);
    assert.equal(req.ephemeral, true);
    assert.equal(req.model, 'gpt-4o');
    assert.equal(req.modelPreset, 'default');
    assert.equal(req.metadata!.k, 'v');
  });

  it('默认值', () => {
    const req = new RequestBuilder().build();
    assert.equal(req.message, '');
    assert.equal(req.type, 'message');
    assert.deepEqual(req.metadata, {});
  });

  it('metadata 单键设置', () => {
    const req = new RequestBuilder().metadata('a', 1).metadata('b', 2).build();
    assert.equal(req.metadata!.a, 1);
    assert.equal(req.metadata!.b, 2);
  });
});

describe('createRequest', () => {
  it('带 options 覆盖默认值', () => {
    const req = createRequest('hi', { ephemeral: true });
    assert.equal(req.message, 'hi');
    assert.equal(req.ephemeral, true);
    assert.equal(req.type, 'message');
  });

  it('无 options 使用默认 type', () => {
    const req = createRequest('hi');
    assert.equal(req.type, 'message');
  });
});

// ─── Result ────────────────────────────────────────────────────────

describe('ResultBuilder', () => {
  it('链式构建成功结果', () => {
    const result = new ResultBuilder()
      .content('hello')
      .toolsUsed(['tool1'])
      .usage({ input: 10, output: 5, total: 15 })
      .stopReason('stop')
      .resources([createMessageResource('user', 'hi')])
      .build();
    assert.equal(result.content, 'hello');
    assert.deepEqual(result.toolsUsed, ['tool1']);
    assert.equal(result.usage.input, 10);
    assert.equal(result.stopReason, 'stop');
    assert.equal(result.success, true);
    assert.ok(result.resources);
    assert.equal(result.resources!.length, 1);
  });

  it('addTool 去重', () => {
    const builder = new ResultBuilder();
    builder.addTool('a').addTool('a').addTool('b');
    const result = builder.build();
    assert.deepEqual(result.toolsUsed, ['a', 'b']);
  });

  it('error 设置后 success=false 且 stopReason=error', () => {
    const result = new ResultBuilder().error('boom').build();
    assert.equal(result.error, 'boom');
    assert.equal(result.success, false);
    assert.equal(result.stopReason, 'error');
  });

  it('metadata 两种重载', () => {
    const b = new ResultBuilder();
    b.metadata('k1', 'v1');
    b.metadata({ k2: 'v2', k3: 'v3' });
    const result = b.build();
    assert.equal(result.metadata.k1, 'v1');
    assert.equal(result.metadata.k2, 'v2');
    assert.equal(result.metadata.k3, 'v3');
  });

  it('默认值', () => {
    const result = new ResultBuilder().build();
    assert.equal(result.content, '');
    assert.deepEqual(result.toolsUsed, []);
    assert.deepEqual(result.usage, {});
    assert.equal(result.stopReason, 'completed');
    assert.deepEqual(result.metadata, {});
    assert.equal(result.success, true);
    assert.equal(result.error, undefined);
    assert.equal(result.resources, undefined);
  });
});

describe('createResult', () => {
  it('带 options 构建', () => {
    const result = createResult('hi', {
      toolsUsed: ['t'],
      usage: { input: 1 },
      stopReason: 'stop',
      error: 'err',
    });
    assert.equal(result.content, 'hi');
    assert.deepEqual(result.toolsUsed, ['t']);
    assert.equal(result.success, false); // error 存在
  });

  it('无 error 时 success=true', () => {
    const result = createResult('hi');
    assert.equal(result.success, true);
    assert.equal(result.error, undefined);
  });
});

describe('createErrorResult', () => {
  it('构建错误结果', () => {
    const result = createErrorResult('something wrong');
    assert.equal(result.error, 'something wrong');
    assert.equal(result.success, false);
    assert.equal(result.stopReason, 'error');
  });
});

// ─── BaseTransformer ───────────────────────────────────────────────

describe('BaseTransformer', () => {
  class TestTransformer extends BaseTransformer {
    readonly name = 'test';
    called = false;
    constructor(options?: { enabled?: boolean; priority?: number }) {
      super(options ?? {});
    }
    protected async run(resources: ContextResource[]): Promise<ContextResource[]> {
      this.called = true;
      return resources;
    }
  }

  it('enabled=true 时执行 run', async () => {
    const t = new TestTransformer();
    const input = [createMessageResource('user', 'hi')];
    await t.transform(input, ctx());
    assert.equal(t.called, true);
  });

  it('enabled=false 时跳过 run', async () => {
    const t = new TestTransformer({ enabled: false });
    const input = [createMessageResource('user', 'hi')];
    await t.transform(input, ctx());
    assert.equal(t.called, false);
  });

  it('默认 priority=100', () => {
    const t = new TestTransformer();
    assert.equal(t.priority, 100);
  });

  it('自定义 priority', () => {
    const t = new TestTransformer({ priority: 50 });
    assert.equal(t.priority, 50);
  });
});
