/**
 * test/multi-agent.test.ts - P0 集成测试
 *
 * 测试 AgentGraph、Pipeline、Router 的核心功能。
 * 使用 mock Runtime 避免依赖真实 LLM API。
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import type { Runtime, Result, Request } from '@aipack-ai/agent';
import { createResult, createRequest } from '@aipack-ai/agent';
import {
  createAgentGraph,
  createPipeline,
  createRouter,
  createSupervisor,
  createDebate,
  createMapReduce,
  createMCPBridge,
  createMultiAgentMcpServerHost,
  createDebugger,
  createSharedContext,
  SimpleEventBus,
  SimpleToolRegistry,
} from '../index.js';
import type { AgentNode, SharedContext } from '../index.js';

// ─── Mock Runtime ────────────────────────────────────────────────

function createMockRuntime(handler: (input: string) => string): Runtime {
  return {
    config: {},
    extensions: {} as any,
    hooks: {} as any,
    run: async (req: Request): Promise<Result> => {
      const content = handler(req.message);
      return createResult(content);
    },
    stream: async function* (_req: Request) {
      yield { type: 'text' as const, content: handler(_req.message) };
    },
    createCompilation: () => ({}) as any,
    registerTool: () => createMockRuntime(handler),
    registerTools: () => createMockRuntime(handler),
    setModel: () => createMockRuntime(handler),
    setSystemPrompt: () => createMockRuntime(handler),
    setThinkingLevel: () => createMockRuntime(handler),
    setStreamFn: () => createMockRuntime(handler),
    registerExtension: () => createMockRuntime(handler),
    useTransformer: () => createMockRuntime(handler),
    getMessages: () => [],
    abort: () => {},
    isBusy: () => false,
    waitForIdle: async () => {},
    clearSession: () => {},
    compact: async () => null,
    deleteSession: async () => true,
    getSessionKeys: () => [],
    hasSession: () => false,
    close: async () => {},
  };
}

function makeNode(id: string, name: string, handler: (input: string) => string): AgentNode {
  return {
    id,
    name,
    description: `${name} agent`,
    runtime: createMockRuntime(handler),
  };
}

/** 真正异步的 mock Runtime（run 会 await handler，用于测试超时/并发时序） */
function createAsyncMockRuntime(handler: (input: string) => Promise<string>): Runtime {
  const base = createMockRuntime(() => '');
  return {
    ...base,
    run: async (req: Request): Promise<Result> => {
      const content = await handler(req.message);
      return createResult(content);
    },
  };
}

// ─── 测试 ────────────────────────────────────────────────────────

describe('SharedContext', () => {
  it('createSharedContext 创建默认上下文', () => {
    const ctx = createSharedContext();
    assert.ok(ctx.blackboard instanceof Map);
    assert.ok(ctx.bus instanceof SimpleEventBus);
    assert.ok(ctx.toolRegistry instanceof SimpleToolRegistry);
    assert.deepEqual(ctx.meta, {});
  });

  it('createSharedContext 接受初始值', () => {
    const ctx = createSharedContext({
      meta: { traceId: 'test-123' },
    });
    assert.equal(ctx.meta.traceId, 'test-123');
  });
});

describe('EventBus', () => {
  it('on/emit 订阅和触发事件', () => {
    const bus = new SimpleEventBus();
    let received: unknown;
    bus.on('test', (data) => { received = data; });
    bus.emit('test', { hello: 'world' });
    assert.deepEqual(received, { hello: 'world' });
  });

  it('off 取消订阅', () => {
    const bus = new SimpleEventBus();
    let count = 0;
    const listener = () => { count++; };
    bus.on('test', listener);
    bus.emit('test');
    assert.equal(count, 1);
    bus.off('test', listener);
    bus.emit('test');
    assert.equal(count, 1);
  });
});

describe('ToolRegistry', () => {
  it('register/get 注册和获取工具', () => {
    const registry = new SimpleToolRegistry();
    const tool = {
      name: 'test_tool',
      description: 'A test tool',
      parameters: {},
      execute: async () => ({ content: [], details: null }),
    };
    registry.register(tool);
    assert.equal(registry.get('test_tool'), tool);
    assert.equal(registry.has('test_tool'), true);
    assert.equal(registry.has('nonexistent'), false);
  });

  it('registerAll 批量注册', () => {
    const registry = new SimpleToolRegistry();
    registry.registerAll([
      { name: 'a', description: 'a', parameters: {}, execute: async () => ({ content: [], details: null }) },
      { name: 'b', description: 'b', parameters: {}, execute: async () => ({ content: [], details: null }) },
    ]);
    assert.equal(registry.getAll().length, 2);
  });
});

describe('AgentGraph', () => {
  it('基本线性图执行：A → B', async () => {
    const nodeA = makeNode('a', 'AgentA', (input) => `[A: ${input}]`);
    const nodeB = makeNode('b', 'AgentB', (input) => `[B: ${input}]`);

    const graph = createAgentGraph()
      .addNode(nodeA)
      .addNode(nodeB)
      .addEdge({ from: 'a', to: 'b' })
      .setEntry('a');

    const result = await graph.run('hello');
    assert.equal(result.success, true);
    assert.equal(result.lastAgentId, 'b');
    assert.equal(result.stepsCompleted, 2);
    assert.ok(result.content.includes('[B:'));
  });

  it('条件边：满足条件走B，否则走C', async () => {
    const nodeA = makeNode('a', 'AgentA', () => 'go-b');
    const nodeB = makeNode('b', 'AgentB', () => 'reached-b');
    const nodeC = makeNode('c', 'AgentC', () => 'reached-c');

    const graph = createAgentGraph()
      .addNode(nodeA)
      .addNode(nodeB)
      .addNode(nodeC)
      .addEdge({
        from: 'a',
        to: 'b',
        condition: (result) => result.content === 'go-b',
      })
      .addEdge({
        from: 'a',
        to: 'c',
        condition: (result) => result.content !== 'go-b',
      })
      .setEntry('a');

    // 走B
    const resultB = await graph.run('test');
    assert.equal(resultB.lastAgentId, 'b');
    assert.equal(resultB.content, 'reached-b');
  });

  it('setFinish 终止条件', async () => {
    const nodeA = makeNode('a', 'AgentA', () => 'done');
    const nodeB = makeNode('b', 'AgentB', () => 'should-not-reach');

    const graph = createAgentGraph()
      .addNode(nodeA)
      .addNode(nodeB)
      .addEdge({ from: 'a', to: 'b' })
      .setEntry('a')
      .setFinish((ctx) => ctx.blackboard.get('stop') === true);

    // AgentA 的 outputMapping 设置停止标记
    nodeA.outputMapping = (_result, ctx) => {
      ctx.blackboard.set('stop', true);
    };

    const result = await graph.run('test');
    assert.equal(result.lastAgentId, 'a');
    assert.equal(result.stopReason, 'finish_condition');
  });

  it('edge.transform 转换传递给下一节点的输入', async () => {
    let receivedByB = '';
    const nodeA = makeNode('a', 'AgentA', () => 'raw-output');
    const nodeB = makeNode('b', 'AgentB', (input) => { receivedByB = input; return 'done'; });

    const graph = createAgentGraph()
      .addNode(nodeA)
      .addNode(nodeB)
      .addEdge({
        from: 'a',
        to: 'b',
        transform: (result) => `transformed: ${result.content}`,
      })
      .setEntry('a');

    await graph.run('test');
    assert.equal(receivedByB, 'transformed: raw-output');
  });

  it('node.outputMapping 将结果写入 SharedContext', async () => {
    const nodeA = makeNode('a', 'AgentA', () => 'step1-result');
    nodeA.outputMapping = (result, ctx) => {
      ctx.blackboard.set('step1', result.content);
    };

    let receivedByB = '';
    const nodeB = makeNode('b', 'AgentB', (_input) => {
      // 通过 inputMapping 从 blackboard 读取
      return 'done';
    });
    nodeB.inputMapping = (ctx) => {
      const step1 = ctx.blackboard.get('step1') as string;
      receivedByB = step1;
      return step1;
    };

    const graph = createAgentGraph()
      .addNode(nodeA)
      .addNode(nodeB)
      .addEdge({ from: 'a', to: 'b' })
      .setEntry('a');

    await graph.run('test');
    assert.equal(receivedByB, 'step1-result');
  });

  it('缺少入口节点时抛出错误', async () => {
    const nodeA = makeNode('a', 'AgentA', () => 'test');
    const graph = createAgentGraph().addNode(nodeA);
    await assert.rejects(
      () => graph.run('test'),
      { message: /入口节点未设置/ },
    );
  });

  it('流式执行产出事件序列', async () => {
    const nodeA = makeNode('a', 'AgentA', () => 'result-a');
    const nodeB = makeNode('b', 'AgentB', () => 'result-b');

    const graph = createAgentGraph()
      .addNode(nodeA)
      .addNode(nodeB)
      .addEdge({ from: 'a', to: 'b' })
      .setEntry('a');

    const events: string[] = [];
    for await (const event of graph.stream('test')) {
      events.push(event.type);
    }
    assert.ok(events.includes('agent_start'));
    assert.ok(events.includes('agent_result'));
    assert.ok(events.includes('edge_traversed'));
    assert.ok(events.includes('graph_done'));
  });

  it('on() 注册的监听器在 run() 时触发', async () => {
    const nodeA = makeNode('a', 'AgentA', () => 'result-a');
    const nodeB = makeNode('b', 'AgentB', () => 'result-b');

    const graph = createAgentGraph()
      .addNode(nodeA)
      .addNode(nodeB)
      .addEdge({ from: 'a', to: 'b' })
      .setEntry('a');

    const seen: string[] = [];
    graph.on('agent_start', (e) => seen.push(`start:${(e as { agentId: string }).agentId}`));
    graph.on('agent_result', (e) => seen.push(`result:${(e as { agentId: string }).agentId}`));
    graph.on('graph_done', () => seen.push('done'));

    await graph.run('test');
    assert.deepEqual(seen, [
      'start:a', 'result:a',
      'start:b', 'result:b',
      'done',
    ]);
  });

  it('on() 注册的监听器在 stream() 时触发', async () => {
    const nodeA = makeNode('a', 'AgentA', () => 'result-a');
    const graph = createAgentGraph().addNode(nodeA).setEntry('a');

    const seen: string[] = [];
    graph.on('agent_start', () => seen.push('start'));
    graph.on('graph_done', () => seen.push('done'));

    for await (const _event of graph.stream('test')) {
      // 消费流
    }
    assert.deepEqual(seen, ['start', 'done']);
  });

  it('on() 监听器抛出异常不影响执行', async () => {
    const nodeA = makeNode('a', 'AgentA', () => 'ok');
    const graph = createAgentGraph().addNode(nodeA).setEntry('a');
    graph.on('agent_start', () => { throw new Error('listener boom'); });

    const result = await graph.run('test');
    assert.equal(result.success, true);
  });

  it('abort() 中止后续节点执行', async () => {
    const nodeA = makeNode('a', 'AgentA', () => 'result-a');
    const nodeB = makeNode('b', 'AgentB', () => 'result-b');

    const graph = createAgentGraph()
      .addNode(nodeA)
      .addNode(nodeB)
      .addEdge({ from: 'a', to: 'b' })
      .setEntry('a');

    // 第一个节点完成后立即中止
    let abortNext = true;
    graph.on('agent_result', (e) => {
      if (abortNext && (e as { agentId: string }).agentId === 'a') graph.abort();
    });

    const result = await graph.run('test');
    assert.equal(result.stopReason, 'aborted');
    assert.equal(result.success, false);
    assert.equal(result.stepsCompleted, 1);
    assert.equal(result.content, 'result-a');
    assert.equal(result.agentResults.has('b'), false);
  });

  it('abort() 后可再次 run（中止信号重置）', async () => {
    const nodeA = makeNode('a', 'AgentA', () => 'result-a');
    const nodeB = makeNode('b', 'AgentB', () => 'result-b');

    const graph = createAgentGraph()
      .addNode(nodeA)
      .addNode(nodeB)
      .addEdge({ from: 'a', to: 'b' })
      .setEntry('a');

    let abortNext = true;
    graph.on('agent_result', (e) => {
      if (abortNext && (e as { agentId: string }).agentId === 'a') graph.abort();
    });
    const first = await graph.run('test');
    assert.equal(first.stopReason, 'aborted');

    // 关闭中止逻辑后，同一 graph 实例可正常完整执行
    abortNext = false;
    const second = await graph.run('test');
    assert.equal(second.success, true);
    assert.equal(second.lastAgentId, 'b');
  });

  it('原始输入写入 blackboard.__original_input__', async () => {
    const nodeA = makeNode('a', 'AgentA', () => 'ok');
    const graph = createAgentGraph().addNode(nodeA).setEntry('a');

    const result = await graph.run('原始输入文本');
    assert.equal(result.context.blackboard.get('__original_input__'), '原始输入文本');
  });

  it('二次 run 状态隔离（不残留上次的 nodeStates）', async () => {
    const nodeA = makeNode('a', 'AgentA', () => 'result-a');
    const nodeB = makeNode('b', 'AgentB', () => 'result-b');

    const graph = createAgentGraph()
      .addNode(nodeA)
      .addNode(nodeB)
      .addEdge({ from: 'a', to: 'b' })
      .setEntry('a');

    const first = await graph.run('test');
    assert.equal(first.stepsCompleted, 2);

    // 第二次 run：stepsCompleted 应重新计数，而非累加
    const second = await graph.run('test');
    assert.equal(second.stepsCompleted, 2);
    assert.equal(second.agentResults.size, 2);
  });

  it('run 失败后二次 run 状态重置', async () => {
    let shouldFail = true;
    const nodeA = makeNode('a', 'AgentA', () => {
      if (shouldFail) throw new Error('boom');
      return 'ok';
    });
    const graph = createAgentGraph().addNode(nodeA).setEntry('a');

    const first = await graph.run('test');
    assert.equal(first.success, false);
    assert.equal(graph.getState().nodeStates.get('a'), 'failed');

    shouldFail = false;
    const second = await graph.run('test');
    assert.equal(second.success, true);
    assert.equal(second.stepsCompleted, 1);
  });

  it('getState 返回快照，外部修改不影响内部状态', async () => {
    const nodeA = makeNode('a', 'AgentA', () => 'ok');
    const graph = createAgentGraph().addNode(nodeA).setEntry('a');
    await graph.run('test');

    const snapshot = graph.getState();
    snapshot.nodeStates.set('a', 'failed');
    snapshot.nodeStates.set('hacked', 'completed');
    snapshot.stepsCompleted = 999;

    const fresh = graph.getState();
    assert.equal(fresh.nodeStates.get('a'), 'completed');
    assert.equal(fresh.nodeStates.has('hacked'), false);
    assert.equal(fresh.stepsCompleted, 1);
  });

  it('环图超限安全截断返回 max_visits_exceeded', async () => {
    const nodeA = makeNode('a', 'AgentA', () => 'loop');
    const nodeB = makeNode('b', 'AgentB', () => 'loop');

    const graph = createAgentGraph()
      .addNode(nodeA)
      .addNode(nodeB)
      .addEdge({ from: 'a', to: 'b' })
      .addEdge({ from: 'b', to: 'a' })
      .setEntry('a');

    const result = await graph.run('test');
    assert.equal(result.stopReason, 'max_visits_exceeded');
    assert.equal(result.success, true);
  });

  it('agent_start 事件携带输入摘要', async () => {
    const nodeA = makeNode('a', 'AgentA', (input) => `out: ${input}`);
    const graph = createAgentGraph().addNode(nodeA).setEntry('a');

    const starts: Array<string | undefined> = [];
    graph.on('agent_start', (e) => { starts.push((e as { input?: string }).input); });

    await graph.run('hello-input');
    assert.deepEqual(starts, ['hello-input']);
  });

  it('并行分支：多条边匹配时并行执行并发出 parallel 事件', async () => {
    const nodeA = makeNode('a', 'AgentA', () => 'fanout');
    const nodeB = makeNode('b', 'AgentB', (input) => `B:${input}`);
    const nodeC = makeNode('c', 'AgentC', (input) => `C:${input}`);

    const graph = createAgentGraph()
      .addNode(nodeA)
      .addNode(nodeB)
      .addNode(nodeC)
      .addEdge({ from: 'a', to: 'b' })
      .addEdge({ from: 'a', to: 'c' })
      .setEntry('a');

    const result = await graph.run('test');
    assert.equal(result.success, true);
    assert.equal(result.stepsCompleted, 3); // a + b + c（并行）
    assert.ok(result.agentResults.has('b'));
    assert.ok(result.agentResults.has('c'));
  });

  it('并行分支发出 parallel_start / parallel_done 事件', async () => {
    const nodeA = makeNode('a', 'AgentA', () => 'fanout');
    const nodeB = makeNode('b', 'AgentB', () => 'B');
    const nodeC = makeNode('c', 'AgentC', () => 'C');

    const graph = createAgentGraph()
      .addNode(nodeA)
      .addNode(nodeB)
      .addNode(nodeC)
      .addEdge({ from: 'a', to: 'b' })
      .addEdge({ from: 'a', to: 'c' })
      .setEntry('a');

    const events: string[] = [];
    for await (const event of graph.stream('test')) {
      events.push(event.type);
    }
    assert.ok(events.includes('parallel_start'));
    assert.ok(events.includes('parallel_done'));
    assert.ok(events.includes('graph_done'));
  });

  it('并行分支 fail-fast：任一分支失败整体失败', async () => {
    const nodeA = makeNode('a', 'AgentA', () => 'fanout');
    const nodeB = makeNode('b', 'AgentB', () => 'ok');
    const nodeC = makeNode('c', 'AgentC', () => { throw new Error('branch-boom'); });

    const graph = createAgentGraph()
      .addNode(nodeA)
      .addNode(nodeB)
      .addNode(nodeC)
      .addEdge({ from: 'a', to: 'b' })
      .addEdge({ from: 'a', to: 'c' })
      .setEntry('a');

    const result = await graph.run('test');
    assert.equal(result.success, false);
    assert.equal(result.stopReason, 'error');
    assert.ok(result.error!.includes('branch-boom'));
  });

  it('并行分支后汇聚到共同下游节点', async () => {
    // a fan-out 到 b/c，b/c 都汇到 d
    const nodeA = makeNode('a', 'AgentA', () => 'fanout');
    const nodeB = makeNode('b', 'AgentB', () => 'B-done');
    const nodeC = makeNode('c', 'AgentC', () => 'C-done');
    let receivedByD = '';
    const nodeD = makeNode('d', 'AgentD', (input) => { receivedByD = input; return 'D'; });

    const graph = createAgentGraph()
      .addNode(nodeA)
      .addNode(nodeB)
      .addNode(nodeC)
      .addNode(nodeD)
      .addEdge({ from: 'a', to: 'b' })
      .addEdge({ from: 'a', to: 'c' })
      .addEdge({ from: 'b', to: 'd' })
      .addEdge({ from: 'c', to: 'd' })
      .setEntry('a');

    const result = await graph.run('test');
    assert.equal(result.stepsCompleted, 4);
    assert.equal(result.lastAgentId, 'd');
    // d 的输入来自首个完成出边（b 或 c，按 frontier 顺序取 b）
    assert.ok(['B-done', 'C-done'].includes(receivedByD));
  });

  it('concurrency 限制并行分支并发数', async () => {
    let running = 0;
    let maxRunning = 0;
    const track = (input: string) => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      running--;
      return `done: ${input}`;
    };
    const nodeA = makeNode('a', 'AgentA', () => 'fanout');
    const nodes = ['b', 'c', 'd'].map(id => makeNode(id, `N${id}`, track));

    const graph = createAgentGraph({ concurrency: 2 })
      .addNode(nodeA)
      .addNode(nodes[0])
      .addNode(nodes[1])
      .addNode(nodes[2])
      .addEdge({ from: 'a', to: 'b' })
      .addEdge({ from: 'a', to: 'c' })
      .addEdge({ from: 'a', to: 'd' })
      .setEntry('a');

    const result = await graph.run('test');
    assert.equal(result.stepsCompleted, 4);
    // mock 是同步的，maxRunning 恒为 1；此处主要验证限流路径可正常完成
    assert.equal(result.success, true);
  });

  it('maxVisitsPerNode 可配置', async () => {
    const nodeA = makeNode('a', 'AgentA', () => 'loop');
    const nodeB = makeNode('b', 'AgentB', () => 'loop');

    const graph = createAgentGraph({ maxVisitsPerNode: 2 })
      .addNode(nodeA)
      .addNode(nodeB)
      .addEdge({ from: 'a', to: 'b' })
      .addEdge({ from: 'b', to: 'a' })
      .setEntry('a');

    const result = await graph.run('test');
    assert.equal(result.stopReason, 'max_visits_exceeded');
    // 入口1次 + b 2次 + a 2次 = 5 步
    assert.equal(result.stepsCompleted, 5);
  });

  it('节点级 retry：失败后自动重试成功', async () => {
    let attempts = 0;
    const nodeA = makeNode('a', 'AgentA', () => {
      attempts++;
      if (attempts < 3) throw new Error('transient-boom');
      return 'recovered';
    });
    nodeA.retry = { maxAttempts: 3 };

    const graph = createAgentGraph().addNode(nodeA).setEntry('a');
    const result = await graph.run('test');

    assert.equal(attempts, 3);
    assert.equal(result.success, true);
    assert.equal(result.content, 'recovered');
  });

  it('节点级 retry：超过最大次数后失败', async () => {
    let attempts = 0;
    const nodeA = makeNode('a', 'AgentA', () => {
      attempts++;
      throw new Error(`always-boom-${attempts}`);
    });
    nodeA.retry = { maxAttempts: 2 };

    const graph = createAgentGraph().addNode(nodeA).setEntry('a');
    const result = await graph.run('test');

    assert.equal(attempts, 2);
    assert.equal(result.success, false);
    assert.ok(result.error!.includes('always-boom-2'));
  });

  it('节点级 retry：backoffMs 重试间隔', async () => {
    let attempts = 0;
    const nodeA = makeNode('a', 'AgentA', () => {
      attempts++;
      if (attempts === 1) throw new Error('once-boom');
      return 'ok';
    });
    nodeA.retry = { maxAttempts: 2, backoffMs: 30 };

    const graph = createAgentGraph().addNode(nodeA).setEntry('a');
    const start = Date.now();
    const result = await graph.run('test');
    const elapsed = Date.now() - start;

    assert.equal(result.success, true);
    assert.ok(elapsed >= 30, `elapsed ${elapsed}ms should be >= 30ms`);
  });

  it('节点级 timeoutMs：超时抛出 NodeTimeoutError', async () => {
    const slowRuntime = createAsyncMockRuntime(async () => {
      await new Promise(resolve => setTimeout(resolve, 200));
      return 'too-slow';
    });
    const nodeA: AgentNode = {
      id: 'slow',
      name: 'Slow',
      description: 'slow agent',
      runtime: slowRuntime,
      timeoutMs: 20,
    };

    const graph = createAgentGraph().addNode(nodeA).setEntry('slow');
    const result = await graph.run('test');

    assert.equal(result.success, false);
    assert.ok(result.error!.includes('超时'));
  });

  it('节点级 timeoutMs + retry：超时后重试成功', async () => {
    let attempts = 0;
    const flakyRuntime = createAsyncMockRuntime(async () => {
      attempts++;
      if (attempts === 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
        return 'slow-result';
      }
      return 'fast-result';
    });
    const nodeA: AgentNode = {
      id: 'flaky',
      name: 'Flaky',
      description: 'flaky agent',
      runtime: flakyRuntime,
      timeoutMs: 20,
      retry: { maxAttempts: 2 },
    };

    const graph = createAgentGraph().addNode(nodeA).setEntry('flaky');
    const result = await graph.run('test');

    assert.equal(attempts, 2);
    assert.equal(result.success, true);
    assert.equal(result.content, 'fast-result');
  });
});

describe('Pipeline', () => {
  it('顺序链 A → B → C', async () => {
    const nodeA = makeNode('a', '翻译', (input) => `翻译: ${input}`);
    const nodeB = makeNode('b', '润色', (input) => `润色: ${input}`);
    const nodeC = makeNode('c', '校对', (input) => `校对: ${input}`);

    const pipeline = createPipeline([nodeA, nodeB, nodeC]);
    const result = await pipeline.run('Hello');
    assert.equal(result.success, true);
    assert.equal(result.stepsCompleted, 3);
    assert.equal(result.lastAgentId, 'c');
    assert.ok(result.content.includes('校对:'));
  });

  it('单节点 Pipeline', async () => {
    const nodeA = makeNode('a', 'Solo', (input) => `solo: ${input}`);
    const pipeline = createPipeline([nodeA]);
    const result = await pipeline.run('test');
    assert.equal(result.stepsCompleted, 1);
    assert.equal(result.content, 'solo: test');
  });

  it('空列表抛出错误', () => {
    assert.throws(
      () => createPipeline([]),
      { message: /至少需要一个/ },
    );
  });

  it('Pipeline 的 outputMapping 在节点间传递数据', async () => {
    const nodeA = makeNode('a', 'A', () => 'research-data');
    nodeA.outputMapping = (result, ctx) => {
      ctx.blackboard.set('research', result.content);
    };

    let receivedByB = '';
    const nodeB = makeNode('b', 'B', () => 'final');
    nodeB.inputMapping = (ctx) => {
      receivedByB = ctx.blackboard.get('research') as string;
      return receivedByB;
    };

    const pipeline = createPipeline([nodeA, nodeB]);
    await pipeline.run('query');
    assert.equal(receivedByB, 'research-data');
  });
});

describe('Router', () => {
  it('路由到匹配的目标Agent', async () => {
    const router = makeNode('dispatcher', '调度', () => 'refund');
    const refundAgent = makeNode('refund', '退款', (input) => `处理退款: ${input}`);
    const techAgent = makeNode('tech', '技术', () => '技术支持');

    const routerGraph = createRouter(router, [refundAgent, techAgent], {
      resolve: (result) => result.content.trim(),
    });

    const result = await routerGraph.run('我要退款');
    assert.equal(result.lastAgentId, 'refund');
    assert.ok(result.content.includes('处理退款:'));
  });

  it('路由到另一个目标', async () => {
    const router = makeNode('dispatcher', '调度', () => 'tech');
    const refundAgent = makeNode('refund', '退款', () => '处理退款');
    const techAgent = makeNode('tech', '技术', (input) => `技术支持: ${input}`);

    const routerGraph = createRouter(router, [refundAgent, techAgent], {
      resolve: (result) => result.content.trim(),
    });

    const result = await routerGraph.run('网络连不上');
    assert.equal(result.lastAgentId, 'tech');
    assert.ok(result.content.includes('技术支持:'));
  });

  it('缺少目标Agent时抛出错误', () => {
    const router = makeNode('dispatcher', '调度', () => 'x');
    assert.throws(
      () => createRouter(router, [], { resolve: (r) => r.content }),
      { message: /至少需要一个/ },
    );
  });

  it('passOriginalInput=false 传递路由器输出', async () => {
    const router = makeNode('dispatcher', '调度', () => 'target');
    let receivedInput = '';
    const targetAgent = makeNode('target', '目标', (input) => { receivedInput = input; return 'done'; });

    const routerGraph = createRouter(router, [targetAgent], {
      resolve: () => 'target',
      passOriginalInput: false,
    });

    await routerGraph.run('用户原始问题');
    // passOriginalInput=false 时，传递路由器的输出
    assert.equal(receivedInput, 'target');
  });

  it('默认 passOriginalInput=true 传递用户原始输入', async () => {
    const router = makeNode('dispatcher', '调度', () => 'target');
    let receivedInput = '';
    const targetAgent = makeNode('target', '目标', (input) => { receivedInput = input; return 'done'; });

    const routerGraph = createRouter(router, [targetAgent], {
      resolve: () => 'target',
    });

    await routerGraph.run('用户原始问题');
    // 默认传递用户原始输入（依赖 GraphExecutor 写入 __original_input__）
    assert.equal(receivedInput, '用户原始问题');
  });

  it('Request 输入时默认传递 message 文本', async () => {
    const router = makeNode('dispatcher', '调度', () => 'target');
    let receivedInput = '';
    const targetAgent = makeNode('target', '目标', (input) => { receivedInput = input; return 'done'; });

    const routerGraph = createRouter(router, [targetAgent], {
      resolve: () => 'target',
    });

    await routerGraph.run(createRequest('请求体输入'));
    assert.equal(receivedInput, '请求体输入');
  });

  it('defaultTarget 兜底路由未知目标', async () => {
    // resolve 返回的目标 ID 不在目标列表中 → 回退到 defaultTarget
    const router = makeNode('dispatcher', '调度', () => 'unknown-agent');
    const techAgent = makeNode('tech', '技术', (input) => `技术支持: ${input}`);
    const generalAgent = makeNode('general', '通用', (input) => `通用客服: ${input}`);

    const routerGraph = createRouter(router, [techAgent, generalAgent], {
      resolve: (result) => result.content.trim(),
      defaultTarget: 'general',
    });

    const result = await routerGraph.run('奇怪的问题');
    assert.equal(result.lastAgentId, 'general');
    assert.ok(result.content.includes('通用客服:'));
  });

  it('defaultTarget 无效时保持原有行为（不匹配则止于路由器）', async () => {
    const router = makeNode('dispatcher', '调度', () => 'unknown-agent');
    const techAgent = makeNode('tech', '技术', () => '技术支持');

    // defaultTarget 指向不存在的 Agent → 不生效，resolve 结果原样返回，无边匹配
    const routerGraph = createRouter(router, [techAgent], {
      resolve: (result) => result.content.trim(),
      defaultTarget: 'nonexistent',
    });

    const result = await routerGraph.run('问题');
    assert.equal(result.lastAgentId, 'dispatcher');
  });
});

describe('Supervisor', () => {
  it('并行执行所有 Worker', async () => {
    const pm = makeNode('pm', 'PM', () => 'task-list');
    pm.outputMapping = (result, ctx) => {
      ctx.blackboard.set('tasks', [
        { assignee: 'fe', task: 'build-ui' },
        { assignee: 'be', task: 'build-api' },
      ]);
    };

    const fe = makeNode('fe', '前端', (input) => `fe-done: ${input}`);
    const be = makeNode('be', '后端', (input) => `be-done: ${input}`);

    const team = createSupervisor(pm, [fe, be], { schedule: 'parallel' });
    const result = await team.run('开发登录功能');

    assert.equal(result.success, true);
    assert.equal(result.stepsCompleted, 3); // pm + fe + be
    // 并行模式下两个 worker 都应完成
    assert.ok(result.agentResults.has('fe'));
    assert.ok(result.agentResults.has('be'));
  });

  it('顺序执行 Worker', async () => {
    const executionOrder: string[] = [];

    const pm = makeNode('pm', 'PM', () => {
      executionOrder.push('pm');
      return 'task-list';
    });
    pm.outputMapping = (result, ctx) => {
      ctx.blackboard.set('tasks', [
        { assignee: 'fe', task: 'build-ui' },
        { assignee: 'be', task: 'build-api' },
      ]);
    };

    const fe = makeNode('fe', '前端', () => {
      executionOrder.push('fe');
      return 'fe-done';
    });
    const be = makeNode('be', '后端', () => {
      executionOrder.push('be');
      return 'be-done';
    });

    const team = createSupervisor(pm, [fe, be], { schedule: 'sequential' });
    await team.run('开发登录功能');

    assert.deepEqual(executionOrder, ['pm', 'fe', 'be']);
  });

  it('Worker 的 inputMapping 从 blackboard 读取分配的任务', async () => {
    const pm = makeNode('pm', 'PM', () => 'ok');
    pm.outputMapping = (_result, ctx) => {
      ctx.blackboard.set('tasks', [
        { assignee: 'fe', task: '实现登录页面' },
        { assignee: 'be', task: '实现登录API' },
      ]);
    };

    let feInput = '';
    let beInput = '';
    const fe = makeNode('fe', '前端', (input) => { feInput = input; return 'fe-done'; });
    fe.inputMapping = (ctx) => {
      const tasks = ctx.blackboard.get('tasks') as Array<{ assignee: string; task: string }>;
      const myTask = tasks.find(t => t.assignee === 'fe');
      return myTask!.task;
    };
    const be = makeNode('be', '后端', (input) => { beInput = input; return 'be-done'; });
    be.inputMapping = (ctx) => {
      const tasks = ctx.blackboard.get('tasks') as Array<{ assignee: string; task: string }>;
      const myTask = tasks.find(t => t.assignee === 'be');
      return myTask!.task;
    };

    const team = createSupervisor(pm, [fe, be], { schedule: 'parallel' });
    await team.run('开发登录功能');

    assert.equal(feInput, '实现登录页面');
    assert.equal(beInput, '实现登录API');
  });

  it('Worker 的 outputMapping 写入 blackboard 供后续 Worker 读取', async () => {
    const pm = makeNode('pm', 'PM', () => 'ok');
    pm.outputMapping = (_result, ctx) => {
      ctx.blackboard.set('tasks', [
        { assignee: 'fe', task: '前端' },
        { assignee: 'be', task: '后端' },
      ]);
    };

    const fe = makeNode('fe', '前端', () => 'login-page');
    fe.inputMapping = (ctx) => {
      const tasks = ctx.blackboard.get('tasks') as Array<{ assignee: string; task: string }>;
      return tasks.find(t => t.assignee === 'fe')!.task;
    };
    fe.outputMapping = (result, ctx) => {
      ctx.blackboard.set('fe_result', result.content);
    };

    let qaInput = '';
    const qa = makeNode('qa', 'QA', (input) => { qaInput = input; return 'test-cases'; });
    qa.inputMapping = (ctx) => {
      return `基于前端方案: ${ctx.blackboard.get('fe_result')}`;
    };

    const team = createSupervisor(pm, [fe, qa], { schedule: 'sequential' });
    await team.run('开发登录功能');

    assert.equal(qaInput, '基于前端方案: login-page');
  });

  it('auto 调度：无 inputMapping 的并行，有的顺序', async () => {
    const executionOrder: string[] = [];

    const pm = makeNode('pm', 'PM', () => {
      executionOrder.push('pm');
      return 'task-list';
    });
    pm.outputMapping = (_result, ctx) => {
      ctx.blackboard.set('tasks', [
        { assignee: 'fe', task: 'build-ui' },
        { assignee: 'be', task: 'build-api' },
      ]);
    };

    // fe 和 be 没有 inputMapping，应并行
    const fe = makeNode('fe', '前端', () => { executionOrder.push('fe'); return 'fe-done'; });
    const be = makeNode('be', '后端', () => { executionOrder.push('be'); return 'be-done'; });

    // qa 有 inputMapping，应在 fe/be 之后执行
    const qa = makeNode('qa', 'QA', () => { executionOrder.push('qa'); return 'qa-done'; });
    qa.inputMapping = (ctx) => {
      const feRes = ctx.blackboard.get('fe_result') ?? 'none';
      const beRes = ctx.blackboard.get('be_result') ?? 'none';
      return `review: ${feRes}, ${beRes}`;
    };

    const team = createSupervisor(pm, [fe, be, qa], { schedule: 'auto' });
    const result = await team.run('开发登录功能');

    assert.equal(result.success, true);
    assert.equal(executionOrder[0], 'pm');
    // qa 应该在 fe 和 be 之后
    const qaIndex = executionOrder.indexOf('qa');
    const feIndex = executionOrder.indexOf('fe');
    const beIndex = executionOrder.indexOf('be');
    assert.ok(qaIndex > feIndex);
    assert.ok(qaIndex > beIndex);
  });

  it('空 Worker 列表抛出错误', () => {
    const pm = makeNode('pm', 'PM', () => 'ok');
    assert.throws(
      () => createSupervisor(pm, []),
      { message: /至少需要一个/ },
    );
  });

  it('Worker 结果自动写入 blackboard（{id}_result）', async () => {
    const pm = makeNode('pm', 'PM', () => 'ok');
    pm.outputMapping = (_result, ctx) => {
      ctx.blackboard.set('tasks', [
        { assignee: 'worker1', task: 'do-thing' },
      ]);
    };

    const worker1 = makeNode('worker1', 'Worker1', () => 'result-from-w1');
    worker1.inputMapping = (ctx) => {
      const tasks = ctx.blackboard.get('tasks') as Array<{ assignee: string; task: string }>;
      return tasks.find(t => t.assignee === 'worker1')!.task;
    };

    const team = createSupervisor(pm, [worker1]);
    const result = await team.run('test');

    // 检查 blackboard 中有 worker1_result
    assert.equal(result.context.blackboard.get('worker1_result'), 'result-from-w1');
  });

  it('流式执行产出事件序列', async () => {
    const pm = makeNode('pm', 'PM', () => 'ok');
    pm.outputMapping = (_result, ctx) => {
      ctx.blackboard.set('tasks', [
        { assignee: 'fe', task: 'build' },
        { assignee: 'be', task: 'build' },
      ]);
    };

    const fe = makeNode('fe', '前端', () => 'fe-done');
    const be = makeNode('be', '后端', () => 'be-done');

    const team = createSupervisor(pm, [fe, be], { schedule: 'parallel' });

    const events: string[] = [];
    for await (const event of team.stream('test')) {
      events.push(event.type);
    }

    assert.ok(events.includes('agent_start'));
    assert.ok(events.includes('agent_result'));
    assert.ok(events.includes('parallel_start'));
    assert.ok(events.includes('parallel_done'));
    assert.ok(events.includes('graph_done'));
  });

  it('并行 Worker 失败默认 fail-fast（返回 error 结果）', async () => {
    const pm = makeNode('pm', 'PM', () => 'ok');
    pm.outputMapping = (_result, ctx) => {
      ctx.blackboard.set('tasks', [
        { assignee: 'good', task: 't1' },
        { assignee: 'bad', task: 't2' },
      ]);
    };

    const good = makeNode('good', 'Good', (input) => `good: ${input}`);
    const bad = makeNode('bad', 'Bad', () => { throw new Error('worker-boom'); });

    const team = createSupervisor(pm, [good, bad], { schedule: 'parallel' });
    const result = await team.run('test');

    assert.equal(result.success, false);
    assert.equal(result.stopReason, 'error');
    assert.ok(result.error!.includes('worker-boom'));
  });

  it('onWorkerError=skip 容忍 Worker 失败', async () => {
    const pm = makeNode('pm', 'PM', () => 'ok');
    pm.outputMapping = (_result, ctx) => {
      ctx.blackboard.set('tasks', [
        { assignee: 'good', task: 't1' },
        { assignee: 'bad', task: 't2' },
      ]);
    };

    const good = makeNode('good', 'Good', () => 'good-result');
    const bad = makeNode('bad', 'Bad', () => { throw new Error('worker-boom'); });

    const team = createSupervisor(pm, [good, bad], { schedule: 'parallel', onWorkerError: 'skip' });
    const result = await team.run('test');

    assert.equal(result.success, true);
    assert.equal(result.stopReason, 'partial_failure');
    assert.deepEqual(result.failedAgents, ['bad']);
    assert.ok(result.agentResults.has('good'));
    assert.equal(result.content, 'good-result');
  });

  it('onWorkerError=skip + 限流并发容忍失败', async () => {
    const pm = makeNode('pm', 'PM', () => 'ok');
    const w1 = makeNode('w1', 'W1', () => 'r1');
    const w2 = makeNode('w2', 'W2', () => { throw new Error('w2-boom'); });
    const w3 = makeNode('w3', 'W3', () => 'r3');

    const team = createSupervisor(pm, [w1, w2, w3], {
      schedule: 'parallel',
      concurrency: 1,
      onWorkerError: 'skip',
    });
    const result = await team.run('test');

    assert.equal(result.success, true);
    assert.equal(result.stopReason, 'partial_failure');
    assert.deepEqual(result.failedAgents, ['w2']);
    assert.ok(result.agentResults.has('w1'));
    assert.ok(result.agentResults.has('w3'));
  });

  it('on() 监听器在 Supervisor run() 时触发', async () => {
    const pm = makeNode('pm', 'PM', () => 'ok');
    const w1 = makeNode('w1', 'W1', () => 'r1');

    const team = createSupervisor(pm, [w1], { schedule: 'parallel' });
    const seen: string[] = [];
    team.on('agent_start', () => seen.push('start'));
    team.on('graph_done', () => seen.push('done'));

    await team.run('test');
    assert.equal(seen.length, 3); // pm + w1 两次 start + done
    assert.equal(seen[seen.length - 1], 'done');
  });

  it('auto 调度：dependsOn 显式声明依赖分层', async () => {
    const executionOrder: string[] = [];
    const pm = makeNode('pm', 'PM', () => 'ok');

    const fe = makeNode('fe', '前端', () => { executionOrder.push('fe'); return 'fe-done'; });
    const be = makeNode('be', '后端', () => { executionOrder.push('be'); return 'be-done'; });
    // qa 依赖 fe 和 be；deploy 依赖 qa
    const qa = makeNode('qa', 'QA', () => { executionOrder.push('qa'); return 'qa-done'; });
    qa.dependsOn = ['fe', 'be'];
    const deploy = makeNode('deploy', '部署', () => { executionOrder.push('deploy'); return 'deploy-done'; });
    deploy.dependsOn = ['qa'];

    const team = createSupervisor(pm, [fe, be, qa, deploy], { schedule: 'auto' });
    const result = await team.run('test');

    assert.equal(result.success, true);
    assert.equal(executionOrder[0] === 'fe' || executionOrder[0] === 'be', true);
    // qa 必须在 fe/be 之后，deploy 必须在 qa 之后
    assert.ok(executionOrder.indexOf('qa') > executionOrder.indexOf('fe'));
    assert.ok(executionOrder.indexOf('qa') > executionOrder.indexOf('be'));
    assert.ok(executionOrder.indexOf('deploy') > executionOrder.indexOf('qa'));
    assert.equal(result.stepsCompleted, 5); // pm + 4 workers
  });

  it('auto 调度：dependsOn 引用不存在的 Worker 报错', async () => {
    const pm = makeNode('pm', 'PM', () => 'ok');
    const w1 = makeNode('w1', 'W1', () => 'r1');
    w1.dependsOn = ['ghost'];

    const team = createSupervisor(pm, [w1], { schedule: 'auto' });
    const result = await team.run('test');

    assert.equal(result.success, false);
    assert.ok(result.error!.includes('ghost'));
  });

  it('auto 调度：dependsOn 成环报错', async () => {
    const pm = makeNode('pm', 'PM', () => 'ok');
    const w1 = makeNode('w1', 'W1', () => 'r1');
    const w2 = makeNode('w2', 'W2', () => 'r2');
    w1.dependsOn = ['w2'];
    w2.dependsOn = ['w1'];

    const team = createSupervisor(pm, [w1, w2], { schedule: 'auto' });
    const result = await team.run('test');

    assert.equal(result.success, false);
    assert.ok(result.error!.includes('环'));
  });

  it('auto 调度：同层并行 + 层间顺序（隐式依赖兼容旧行为）', async () => {
    // 无 dependsOn：无 inputMapping 并行（第 0 层），有 inputMapping 在其后
    const executionOrder: string[] = [];
    const pm = makeNode('pm', 'PM', () => 'ok');
    pm.outputMapping = (_result, ctx) => {
      ctx.blackboard.set('tasks', [
        { assignee: 'fe', task: 'build-ui' },
        { assignee: 'be', task: 'build-api' },
      ]);
    };

    const fe = makeNode('fe', '前端', (input) => { executionOrder.push('fe'); return 'fe-done'; });
    const be = makeNode('be', '后端', (input) => { executionOrder.push('be'); return 'be-done'; });
    const qa = makeNode('qa', 'QA', () => { executionOrder.push('qa'); return 'qa-done'; });
    qa.inputMapping = (ctx) => `review: ${ctx.blackboard.get('fe_result')}, ${ctx.blackboard.get('be_result')}`;

    const team = createSupervisor(pm, [fe, be, qa], { schedule: 'auto' });
    await team.run('开发登录功能');

    // qa 在 fe/be 之后（旧行为保持）
    assert.ok(executionOrder.indexOf('qa') > executionOrder.indexOf('fe'));
    assert.ok(executionOrder.indexOf('qa') > executionOrder.indexOf('be'));
  });
});

describe('Debate', () => {
  it('收敛时提前结束', async () => {
    let round = 0;
    const proposer = makeNode('coder', '代码生成', () => {
      round++;
      return `code-v${round}`;
    });
    const reviewer = makeNode('reviewer', '审查', () => {
      // 第2轮说 LGTM
      return round >= 2 ? 'LGTM' : '有问题，请修复';
    });

    const debate = createDebate(proposer, reviewer, {
      maxRounds: 5,
      convergeWhen: (result) => result.content.includes('LGTM'),
    });

    const result = await debate.run('实现 LRU Cache');
    assert.equal(result.success, true);
    assert.ok(result.stopReason.includes('converged'));
    assert.equal(round, 2); // 第2轮收敛
  });

  it('未收敛时达到最大轮次', async () => {
    let round = 0;
    const proposer = makeNode('coder', '代码生成', () => {
      round++;
      return `code-v${round}`;
    });
    const reviewer = makeNode('reviewer', '审查', () => '还有问题');

    const debate = createDebate(proposer, reviewer, {
      maxRounds: 2,
      convergeWhen: (result) => result.content.includes('LGTM'),
    });

    const result = await debate.run('实现 LRU Cache');
    assert.equal(result.success, true);
    assert.ok(result.stopReason.includes('max_rounds'));
    assert.equal(round, 2); // 达到最大轮次
  });

  it('默认 feedbackTransform 将 reviewer 反馈转为 proposer 输入', async () => {
    let proposerInput = '';
    const proposer = makeNode('coder', '代码生成', (input) => {
      proposerInput = input;
      return 'code-output';
    });
    const reviewer = makeNode('reviewer', '审查', () => 'LGTM');

    const debate = createDebate(proposer, reviewer, {
      maxRounds: 3,
      convergeWhen: () => true,
    });

    await debate.run('原始需求');
    // 第一轮 proposer 的输入是原始需求
    assert.equal(proposerInput, '原始需求');
  });

  it('自定义 feedbackTransform', async () => {
    const inputs: string[] = [];
    const proposer = makeNode('coder', '代码生成', (input) => {
      inputs.push(input);
      return 'code';
    });
    const reviewer = makeNode('reviewer', '审查', () => '需要优化性能');

    const debate = createDebate(proposer, reviewer, {
      maxRounds: 2,
      convergeWhen: () => false, // 永不收敛
      feedbackTransform: (reviewerResult) => `[FIX]: ${reviewerResult.content}`,
    });

    await debate.run('write code');
    // 第二轮 proposer 的输入应来自 feedbackTransform
    assert.ok(inputs[1].includes('[FIX]:'));
    assert.ok(inputs[1].includes('需要优化性能'));
  });

  it('流式执行产出 round_start 和 converged 事件', async () => {
    const proposer = makeNode('coder', '代码生成', () => 'code');
    const reviewer = makeNode('reviewer', '审查', () => 'LGTM');

    const debate = createDebate(proposer, reviewer, {
      maxRounds: 3,
      convergeWhen: (result) => result.content.includes('LGTM'),
    });

    const events: string[] = [];
    for await (const event of debate.stream('test')) {
      events.push(event.type);
    }

    assert.ok(events.includes('round_start'));
    assert.ok(events.includes('converged'));
    assert.ok(events.includes('agent_start'));
    assert.ok(events.includes('agent_result'));
    assert.ok(events.includes('graph_done'));
  });

  it('每轮 proposer 和 reviewer 都执行', async () => {
    const executionLog: string[] = [];
    const proposer = makeNode('coder', '代码生成', () => {
      executionLog.push('proposer');
      return 'code';
    });
    const reviewer = makeNode('reviewer', '审查', () => {
      executionLog.push('reviewer');
      return 'needs-fix';
    });

    const debate = createDebate(proposer, reviewer, {
      maxRounds: 2,
      convergeWhen: () => false,
    });

    await debate.run('test');
    assert.deepEqual(executionLog, ['proposer', 'reviewer', 'proposer', 'reviewer']);
  });
});

describe('MapReduce', () => {
  it('基本并行 map + reduce', async () => {
    const mapper = makeNode('analyzer', '分析', (input) => `分析结果: ${input}`);
    const reducer = makeNode('summarizer', '汇总', (input) => `汇总报告:\n${input}`);

    const mapReduce = createMapReduce(mapper, reducer, {
      split: (input) => input.split(','),
    });

    const result = await mapReduce.run('file1,file2,file3');
    assert.equal(result.success, true);
    assert.ok(result.content.includes('汇总报告'));
    assert.equal(result.lastAgentId, 'summarizer');
    // 3 个 mapper + 1 个 reducer
    assert.equal(result.stepsCompleted, 4);
  });

  it('split 为空数组时抛出错误', async () => {
    const mapper = makeNode('mapper', 'Mapper', () => 'ok');
    const reducer = makeNode('reducer', 'Reducer', () => 'done');

    const mapReduce = createMapReduce(mapper, reducer, {
      split: () => [],
    });

    await assert.rejects(
      () => mapReduce.run('test'),
      { message: /空数组/ },
    );
  });

  it('concurrency 限制并发数', async () => {
    const executionTimes: number[] = [];
    const mapper = makeNode('analyzer', '分析', (input) => {
      executionTimes.push(Date.now());
      return `分析: ${input}`;
    });
    const reducer = makeNode('summarizer', '汇总', (input) => `汇总: ${input}`);

    const mapReduce = createMapReduce(mapper, reducer, {
      split: (input) => input.split(','),
      concurrency: 2,
    });

    const result = await mapReduce.run('a,b,c,d');
    assert.equal(result.success, true);
    assert.equal(result.stepsCompleted, 5); // 4 mappers + 1 reducer
  });

  it('自定义 reduceInputFormat', async () => {
    const mapper = makeNode('analyzer', '分析', (input) => `分析: ${input}`);
    let reducerInput = '';
    const reducer = makeNode('summarizer', '汇总', (input) => {
      reducerInput = input;
      return '汇总完成';
    });

    const mapReduce = createMapReduce(mapper, reducer, {
      split: (input) => input.split(','),
      reduceInputFormat: (mapperResults) => {
        const parts: string[] = [];
        for (const [idx, result] of mapperResults) {
          parts.push(`[${idx + 1}] ${result.content}`);
        }
        return parts.join(' | ');
      },
    });

    await mapReduce.run('a,b');
    assert.ok(reducerInput.includes('[1]'));
    assert.ok(reducerInput.includes('[2]'));
  });

  it('mapper 结果写入 blackboard', async () => {
    const mapper = makeNode('analyzer', '分析', (input) => `分析: ${input}`);
    const reducer = makeNode('summarizer', '汇总', () => 'done');

    const mapReduce = createMapReduce(mapper, reducer, {
      split: (input) => input.split(','),
    });

    const result = await mapReduce.run('a,b');
    const mapperResults = result.context.blackboard.get('mapper_results');
    assert.ok(mapperResults instanceof Map);
    assert.equal((mapperResults as Map<number, Result>).size, 2);
  });

  it('流式执行产出 parallel_start/parallel_done 事件', async () => {
    const mapper = makeNode('analyzer', '分析', (input) => `分析: ${input}`);
    const reducer = makeNode('summarizer', '汇总', () => '汇总完成');

    const mapReduce = createMapReduce(mapper, reducer, {
      split: (input) => input.split(','),
    });

    const events: string[] = [];
    for await (const event of mapReduce.stream('a,b,c')) {
      events.push(event.type);
    }

    assert.ok(events.includes('parallel_start'));
    assert.ok(events.includes('parallel_done'));
    assert.ok(events.includes('agent_start'));
    assert.ok(events.includes('agent_result'));
    assert.ok(events.includes('graph_done'));
  });

  it('mapper 失败默认 fail-fast（返回 error 结果）', async () => {
    const mapper = makeNode('mapper', 'Mapper', (input) => {
      if (input === 'b') throw new Error('map-boom');
      return `ok: ${input}`;
    });
    const reducer = makeNode('reducer', 'Reducer', (input) => `汇总: ${input}`);

    const mapReduce = createMapReduce(mapper, reducer, {
      split: (input) => input.split(','),
    });

    const result = await mapReduce.run('a,b,c');
    assert.equal(result.success, false);
    assert.equal(result.stopReason, 'error');
    assert.ok(result.error!.includes('map-boom'));
  });

  it('onMapperError=skip 容忍 mapper 失败', async () => {
    const mapper = makeNode('mapper', 'Mapper', (input) => {
      if (input === 'b') throw new Error('map-boom');
      return `ok: ${input}`;
    });
    let reducerInput = '';
    const reducer = makeNode('reducer', 'Reducer', (input) => { reducerInput = input; return '汇总完成'; });

    const mapReduce = createMapReduce(mapper, reducer, {
      split: (input) => input.split(','),
      onMapperError: 'skip',
    });

    const result = await mapReduce.run('a,b,c');
    assert.equal(result.success, true);
    assert.equal(result.stopReason, 'partial_failure');
    assert.deepEqual(result.failedAgents, ['mapper_1']);
    // reducer 只收到成功的子任务结果
    assert.ok(reducerInput.includes('ok: a'));
    assert.ok(reducerInput.includes('ok: c'));
    assert.ok(!reducerInput.includes('ok: b'));
  });

  it('onMapperError=skip + 限流并发容忍失败', async () => {
    const mapper = makeNode('mapper', 'Mapper', (input) => {
      if (input === 'b') throw new Error('map-boom');
      return `ok: ${input}`;
    });
    const reducer = makeNode('reducer', 'Reducer', () => '汇总完成');

    const mapReduce = createMapReduce(mapper, reducer, {
      split: (input) => input.split(','),
      concurrency: 1,
      onMapperError: 'skip',
    });

    const result = await mapReduce.run('a,b,c');
    assert.equal(result.success, true);
    assert.equal(result.stopReason, 'partial_failure');
    assert.deepEqual(result.failedAgents, ['mapper_1']);
    assert.equal(result.stepsCompleted, 4); // 2 成功 + 1 失败 mapper + 1 reducer
  });

  it('onMapperError=skip 且全部失败时返回 error', async () => {
    const mapper = makeNode('mapper', 'Mapper', () => { throw new Error('map-boom'); });
    const reducer = makeNode('reducer', 'Reducer', () => 'done');

    const mapReduce = createMapReduce(mapper, reducer, {
      split: (input) => input.split(','),
      onMapperError: 'skip',
    });

    const result = await mapReduce.run('a,b');
    assert.equal(result.success, false);
    assert.ok(result.error!.includes('所有 mapper 均失败'));
  });

  it('on() 监听器在 MapReduce run() 时触发', async () => {
    const mapper = makeNode('mapper', 'Mapper', () => 'ok');
    const reducer = makeNode('reducer', 'Reducer', () => 'done');

    const mapReduce = createMapReduce(mapper, reducer, {
      split: (input) => input.split(','),
    });

    const seen: string[] = [];
    mapReduce.on('agent_start', () => seen.push('start'));
    mapReduce.on('graph_done', () => seen.push('done'));

    await mapReduce.run('a,b');
    // 2 个 mapper + 1 个 reducer 的 start + done
    assert.equal(seen.length, 4);
    assert.equal(seen[seen.length - 1], 'done');
  });

  it('split 每次执行只调用一次（无副作用放大）', async () => {
    let splitCallCount = 0;
    const mapper = makeNode('mapper', 'Mapper', (input) => `ok: ${input}`);
    const reducer = makeNode('reducer', 'Reducer', () => 'done');

    const mapReduce = createMapReduce(mapper, reducer, {
      split: (input) => {
        splitCallCount++;
        return input.split(',');
      },
    });

    await mapReduce.run('a,b,c');
    assert.equal(splitCallCount, 1);
  });

  it('虚拟节点 ID 对齐 nodeStates', async () => {
    const mapper = makeNode('mapper', 'Mapper', (input) => `ok: ${input}`);
    const reducer = makeNode('reducer', 'Reducer', () => 'done');

    const mapReduce = createMapReduce(mapper, reducer, {
      split: (input) => input.split(','),
    });

    const result = await mapReduce.run('a,b');
    const state = mapReduce.getState();
    // mapper 聚合节点 + 2 个虚拟节点 + reducer
    assert.equal(state.nodeStates.get('mapper'), 'completed');
    assert.equal(state.nodeStates.get('mapper_0'), 'completed');
    assert.equal(state.nodeStates.get('mapper_1'), 'completed');
    assert.equal(state.nodeStates.get('reducer'), 'completed');
    // 虚拟节点结果与 nodeResults 键一致
    assert.ok(result.agentResults.has('mapper_0'));
    assert.ok(result.agentResults.has('mapper_1'));
  });

  it('失败 mapper 的虚拟节点状态为 failed', async () => {
    const mapper = makeNode('mapper', 'Mapper', (input) => {
      if (input === 'b') throw new Error('map-boom');
      return `ok: ${input}`;
    });
    const reducer = makeNode('reducer', 'Reducer', () => 'done');

    const mapReduce = createMapReduce(mapper, reducer, {
      split: (input) => input.split(','),
      onMapperError: 'skip',
    });

    await mapReduce.run('a,b,c');
    const state = mapReduce.getState();
    assert.equal(state.nodeStates.get('mapper_0'), 'completed');
    assert.equal(state.nodeStates.get('mapper_1'), 'failed');
    assert.equal(state.nodeStates.get('mapper_2'), 'completed');
  });

  it('二次 run 状态隔离', async () => {
    const mapper = makeNode('mapper', 'Mapper', (input) => `ok: ${input}`);
    const reducer = makeNode('reducer', 'Reducer', () => 'done');

    const mapReduce = createMapReduce(mapper, reducer, {
      split: (input) => input.split(','),
    });

    const first = await mapReduce.run('a,b');
    assert.equal(first.stepsCompleted, 3);

    const second = await mapReduce.run('a');
    assert.equal(second.stepsCompleted, 2); // 1 mapper + 1 reducer，不残留上次虚拟节点
    assert.equal(second.agentResults.size, 2);
  });
});

describe('MCPBridge', () => {
  it('listTools 返回 run 和 status 工具', () => {
    const nodeA = makeNode('a', 'AgentA', () => 'test');
    const graph = createAgentGraph().addNode(nodeA).setEntry('a');
    const bridge = createMCPBridge(graph);

    const tools = bridge.listTools();
    assert.equal(tools.length, 2);
    assert.ok(tools.find(t => t.name === 'run'));
    assert.ok(tools.find(t => t.name === 'status'));
  });

  it('listTools 支持工具名前缀', () => {
    const nodeA = makeNode('a', 'AgentA', () => 'test');
    const graph = createAgentGraph().addNode(nodeA).setEntry('a');
    const bridge = createMCPBridge(graph, { toolPrefix: 'ma_' });

    const tools = bridge.listTools();
    assert.ok(tools.find(t => t.name === 'ma_run'));
    assert.ok(tools.find(t => t.name === 'ma_status'));
  });

  it('handleCall run 工具执行图并返回结果', async () => {
    const nodeA = makeNode('a', 'AgentA', (input) => `result: ${input}`);
    const graph = createAgentGraph().addNode(nodeA).setEntry('a');
    const bridge = createMCPBridge(graph);

    const result = await bridge.handleCall({
      name: 'run',
      arguments: { input: 'hello' },
    });

    assert.equal(result.isError, undefined);
    assert.equal(result.content.length, 1);
    const text = result.content[0].text!;
    assert.ok(text.includes('result: hello'));
    assert.ok(text.includes('"success": true'));
  });

  it('handleCall run 缺少 input 参数返回错误', async () => {
    const nodeA = makeNode('a', 'AgentA', () => 'test');
    const graph = createAgentGraph().addNode(nodeA).setEntry('a');
    const bridge = createMCPBridge(graph);

    const result = await bridge.handleCall({
      name: 'run',
      arguments: {},
    });

    assert.equal(result.isError, true);
    assert.ok(result.content[0].text!.includes('缺少'));
  });

  it('handleCall status 工具返回执行状态', async () => {
    const nodeA = makeNode('a', 'AgentA', () => 'test');
    const graph = createAgentGraph().addNode(nodeA).setEntry('a');
    const bridge = createMCPBridge(graph);

    const result = await bridge.handleCall({
      name: 'status',
      arguments: {},
    });

    assert.equal(result.isError, undefined);
    const text = result.content[0].text!;
    assert.ok(text.includes('nodeStates'));
  });

  it('handleCall 未知工具返回错误', async () => {
    const nodeA = makeNode('a', 'AgentA', () => 'test');
    const graph = createAgentGraph().addNode(nodeA).setEntry('a');
    const bridge = createMCPBridge(graph);

    const result = await bridge.handleCall({
      name: 'nonexistent',
      arguments: {},
    });

    assert.equal(result.isError, true);
    assert.ok(result.content[0].text!.includes('未知工具'));
  });

  it('getServerInfo 返回服务器信息', () => {
    const nodeA = makeNode('a', 'AgentA', () => 'test');
    const graph = createAgentGraph().addNode(nodeA).setEntry('a');
    const bridge = createMCPBridge(graph, { serverName: 'test-server', serverVersion: '2.0.0' });

    const info = bridge.getServerInfo();
    assert.equal(info.name, 'test-server');
    assert.equal(info.version, '2.0.0');
  });

  // ─── M3：asTools / toMcpServerHost（统一 @aipack-ai/mcp 传输路径）────

  it('asTools 返回 JSON Schema 参数的 Tool[]', () => {
    const nodeA = makeNode('a', 'AgentA', () => 'test');
    const graph = createAgentGraph().addNode(nodeA).setEntry('a');
    const bridge = createMCPBridge(graph, { toolPrefix: 'ma_' });

    const tools = bridge.asTools();
    assert.equal(tools.length, 2);
    const run = tools.find((t) => t.name === 'ma_run');
    assert.ok(run);
    assert.deepEqual(run!.parameters, {
      type: 'object',
      properties: { input: { type: 'string', description: '用户输入文本' } },
      required: ['input'],
    });
    assert.equal(run!.permissions?.length, 0);
  });

  it('asTools run execute 与 handleCall 语义一致', async () => {
    const nodeA = makeNode('a', 'AgentA', (input) => `result: ${input}`);
    const graph = createAgentGraph().addNode(nodeA).setEntry('a');
    const bridge = createMCPBridge(graph);

    const run = bridge.asTools().find((t) => t.name === 'run')!;
    const r = await run.execute('mcp', { input: 'hello' });
    const text = (r.content[0] as { text?: string }).text!;
    assert.ok(text.includes('result: hello'));
    assert.ok(text.includes('"success": true'));
    assert.equal(r.details, undefined, '成功时无 details.error');
  });

  it('asTools run 缺 input → details.error', async () => {
    const nodeA = makeNode('a', 'AgentA', () => 'test');
    const graph = createAgentGraph().addNode(nodeA).setEntry('a');
    const bridge = createMCPBridge(graph);

    const run = bridge.asTools().find((t) => t.name === 'run')!;
    const r = await run.execute('mcp', {});
    assert.ok((r.details as { error?: string } | undefined)?.error);
    assert.match((r.details as { error: string }).error, /缺少/);
  });

  it('toMcpServerHost 处理 initialize / tools/list / tools/call / ping', async () => {
    const nodeA = makeNode('a', 'AgentA', (input) => `result: ${input}`);
    const graph = createAgentGraph().addNode(nodeA).setEntry('a');
    const bridge = createMCPBridge(graph, { serverName: 'ma-test' });
    const host = bridge.toMcpServerHost();

    // initialize
    const init = await host.handleRequest({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1.0.0' } },
    }) as { result: { protocolVersion: string; serverInfo: { name: string }; capabilities: { tools?: unknown } } };
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.equal(init.result.serverInfo.name, 'ma-test');
    assert.ok(init.result.capabilities.tools !== undefined);

    // tools/list
    const list = await host.handleRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) as { result: { tools: Array<{ name: string }> } };
    assert.ok(list.result.tools.some((t) => t.name === 'run'));
    assert.ok(list.result.tools.some((t) => t.name === 'status'));

    // tools/call run
    const call = await host.handleRequest({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'run', arguments: { input: 'hi' } },
    }) as { result: { content: Array<{ text: string }>; isError?: boolean } };
    assert.equal(call.result.isError, undefined);
    assert.match(call.result.content[0].text, /result: hi/);

    // ping
    const ping = await host.handleRequest({ jsonrpc: '2.0', id: 4, method: 'ping' }) as { result: unknown };
    assert.deepEqual(ping.result, {});

    // 通知 → null
    assert.equal(await host.handleRequest({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  });

  it('createMultiAgentMcpServerHost 工厂等价于 bridge.toMcpServerHost', async () => {
    const nodeA = makeNode('a', 'AgentA', () => 'test');
    const graph = createAgentGraph().addNode(nodeA).setEntry('a');
    const host = createMultiAgentMcpServerHost(graph, { serverName: 'fac' });
    const init = await host.handleRequest({ jsonrpc: '2.0', id: 1, method: 'initialize' }) as { result: { serverInfo: { name: string } } };
    assert.equal(init.result.serverInfo.name, 'fac');
  });
});

describe('GraphDebugger', () => {
  it('toDOT 导出 DOT 格式', () => {
    const nodeA = makeNode('a', 'AgentA', () => 'test');
    const nodeB = makeNode('b', 'AgentB', () => 'test');
    const graph = createAgentGraph()
      .addNode(nodeA)
      .addNode(nodeB)
      .addEdge({ from: 'a', to: 'b' })
      .setEntry('a');

    const debugger_ = createDebugger(graph);
    debugger_.setGraphMeta([nodeA, nodeB], [{ from: 'a', to: 'b' }], 'a');

    const dot = debugger_.toDOT();
    assert.ok(dot.includes('digraph AgentGraph'));
    assert.ok(dot.includes('"a"'));
    assert.ok(dot.includes('"b"'));
    assert.ok(dot.includes('->'));
  });

  it('toDOT 入口节点高亮', () => {
    const nodeA = makeNode('a', 'AgentA', () => 'test');
    const graph = createAgentGraph().addNode(nodeA).setEntry('a');

    const debugger_ = createDebugger(graph);
    debugger_.setGraphMeta([nodeA], [], 'a');

    const dot = debugger_.toDOT();
    assert.ok(dot.includes('#4CAF50')); // 入口节点颜色
  });

  it('toDOT 条件边用虚线', () => {
    const nodeA = makeNode('a', 'AgentA', () => 'test');
    const nodeB = makeNode('b', 'AgentB', () => 'test');
    const graph = createAgentGraph()
      .addNode(nodeA)
      .addNode(nodeB)
      .addEdge({ from: 'a', to: 'b', condition: () => true })
      .setEntry('a');

    const debugger_ = createDebugger(graph);
    debugger_.setGraphMeta([nodeA, nodeB], [{ from: 'a', to: 'b', condition: () => true }], 'a');

    const dot = debugger_.toDOT();
    assert.ok(dot.includes('dashed'));
  });

  it('trace 执行图并记录 Trace', async () => {
    const nodeA = makeNode('a', 'AgentA', (input) => `result: ${input}`);
    const nodeB = makeNode('b', 'AgentB', (input) => `final: ${input}`);
    const graph = createAgentGraph()
      .addNode(nodeA)
      .addNode(nodeB)
      .addEdge({ from: 'a', to: 'b' })
      .setEntry('a');

    const debugger_ = createDebugger(graph);
    const trace = await debugger_.trace('hello');

    assert.ok(trace.traceId, `traceId missing: ${JSON.stringify(trace)}`);
    assert.ok(trace.duration >= 0, `duration is ${trace.duration}`);
    assert.equal(trace.steps.length, 2);
    assert.equal(trace.steps[0].agentId, 'a');
    assert.equal(trace.steps[1].agentId, 'b');
    assert.equal(trace.steps[0].state, 'completed');
    assert.equal(trace.steps[1].state, 'completed');
  });

  it('trace 记录每步输入摘要与最终结果', async () => {
    const nodeA = makeNode('a', 'AgentA', (input) => `result: ${input}`);
    const nodeB = makeNode('b', 'AgentB', (input) => `final: ${input}`);
    const graph = createAgentGraph()
      .addNode(nodeA)
      .addNode(nodeB)
      .addEdge({ from: 'a', to: 'b' })
      .setEntry('a');

    const debugger_ = createDebugger(graph);
    const trace = await debugger_.trace('hello');

    // 每步记录输入摘要
    assert.equal(trace.steps[0].input, 'hello');
    assert.equal(trace.steps[1].input, 'result: hello');
    // 最终结果来自 graph_done 事件（含真实 content / stopReason）
    assert.equal(trace.result.success, true);
    assert.equal(trace.result.content, 'final: result: hello');
    assert.equal(trace.result.stopReason, 'completed');
    assert.equal(trace.result.stepsCompleted, 2);
  });

  it('trace 失败时报告 success=false 与 error 信息', async () => {
    const nodeA = makeNode('a', 'AgentA', () => { throw new Error('node-boom'); });
    const graph = createAgentGraph().addNode(nodeA).setEntry('a');

    const debugger_ = createDebugger(graph);
    const trace = await debugger_.trace('test');

    assert.equal(trace.result.success, false);
    assert.equal(trace.result.stopReason, 'error');
    assert.equal(trace.steps[0].state, 'failed');
    assert.equal(trace.steps[0].error, 'node-boom');
  });

  it('traceToJSON 输出有效 JSON', async () => {
    const nodeA = makeNode('a', 'AgentA', () => 'ok');
    const graph = createAgentGraph().addNode(nodeA).setEntry('a');

    const debugger_ = createDebugger(graph);
    const trace = await debugger_.trace('test');
    const json = debugger_.traceToJSON(trace);

    const parsed = JSON.parse(json);
    assert.equal(parsed.traceId, trace.traceId);
  });

  it('traceToLog 输出可读日志', async () => {
    const nodeA = makeNode('a', 'AgentA', () => 'ok');
    const graph = createAgentGraph().addNode(nodeA).setEntry('a');

    const debugger_ = createDebugger(graph);
    const trace = await debugger_.trace('test');
    const log = debugger_.traceToLog(trace);

    assert.ok(log.includes('Graph Trace'));
    assert.ok(log.includes('AgentA'));
    assert.ok(log.includes('OK'));
  });
});
