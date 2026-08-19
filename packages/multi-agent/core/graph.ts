/**
 * core/graph.ts - AgentGraph 实现
 *
 * 基于声明式 API（addNode/addEdge/setEntry/setFinish）构建图，
 * 委托 GraphExecutor 执行。
 */

import type { Request } from '@aipack-ai/agent';
import type { AgentNode, AgentEdge, AgentGraph, SharedContext, EventListener, MultiAgentResult, MultiAgentEvent, GraphExecutionState } from './types';
import { GraphExecutor } from './executor';

// ─── AgentGraphImpl ──────────────────────────────────────────────

class AgentGraphImpl implements AgentGraph {
  private executor = new GraphExecutor();
  private eventListeners = new Map<string, Set<EventListener>>();

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
    return this.executor.run(input);
  }

  async *stream(input: string | Request): AsyncGenerator<MultiAgentEvent> {
    yield* this.executor.stream(input);
  }

  getState(): GraphExecutionState {
    return this.executor.getState();
  }

  abort(): void {
    this.executor.abort();
  }

  on(event: string, listener: EventListener): this {
    let set = this.eventListeners.get(event);
    if (!set) {
      set = new Set();
      this.eventListeners.set(event, set);
    }
    set.add(listener);
    return this;
  }
}

// ─── createAgentGraph 工厂函数 ───────────────────────────────────

/** 创建空的 AgentGraph，通过链式调用定义图结构 */
export function createAgentGraph(): AgentGraph {
  return new AgentGraphImpl();
}
