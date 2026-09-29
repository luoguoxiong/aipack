/**
 * core/graph.ts - AgentGraph 实现
 *
 * 基于声明式 API（addNode/addEdge/setEntry/setFinish）构建图，
 * 委托 GraphExecutor 执行。
 */

import type { Request } from '@aipack-ai/agent';
import type { AgentNode, AgentEdge, AgentGraph, SharedContext, EventListener, MultiAgentResult, MultiAgentEvent, GraphExecutionState, GraphExecutionOpts } from './types';
import { GraphExecutor } from './executor';
import { SimpleEventBus } from './context';

// 中止错误类型透传导出（供使用方 instanceof 判断）
export { GraphAbortedError } from './executor';

// ─── AgentGraphImpl ──────────────────────────────────────────────

class AgentGraphImpl implements AgentGraph {
  private executor: GraphExecutor;
  /** on() 注册的监听器，按 MultiAgentEvent.type 分发 */
  private bus = new SimpleEventBus();

  constructor(opts?: GraphExecutionOpts) {
    this.executor = new GraphExecutor(opts);
  }

  addNode(node: AgentNode): this {
    this.executor.addNode(node);
    return this;
  }

  addEdge(edge: AgentEdge): this {
    this.executor.addEdge(edge);
    return this;
  }

  setEntry(agentId: string): this {
    this.executor.setEntry(agentId);
    return this;
  }

  setFinish(condition: (ctx: SharedContext) => boolean): this {
    this.executor.setFinish(condition);
    return this;
  }

  async run(input: string | Request): Promise<MultiAgentResult> {
    this.executor.setEventSink(event => this.bus.emit(event.type, event));
    return this.executor.run(input);
  }

  async *stream(input: string | Request): AsyncGenerator<MultiAgentEvent> {
    this.executor.setEventSink(event => this.bus.emit(event.type, event));
    yield* this.executor.stream(input);
  }

  getState(): GraphExecutionState {
    return this.executor.getState();
  }

  abort(): void {
    this.executor.abort();
  }

  on(event: string, listener: EventListener): this {
    this.bus.on(event, listener);
    return this;
  }
}

// ─── createAgentGraph 工厂函数 ───────────────────────────────────

/** 创建空的 AgentGraph，通过链式调用定义图结构 */
export function createAgentGraph(opts?: GraphExecutionOpts): AgentGraph {
  return new AgentGraphImpl(opts);
}
