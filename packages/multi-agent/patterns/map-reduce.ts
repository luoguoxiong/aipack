/**
 * patterns/map-reduce.ts - MapReduce 并行聚合模式
 *
 * 将输入拆分为子任务，用 mapper 并行处理，再用 reducer 汇总。
 */

import type { AgentNode, AgentGraph, MapReduceOpts, EventListener, MultiAgentResult, MultiAgentEvent } from '../core/types';
import { MapReduceExecutor } from '../core/map-reduce-executor';
import { SimpleEventBus } from '../core/context';
import type { Request } from '@aipack-ai/agent';

// ─── MapReduceGraphImpl ──────────────────────────────────────────

class MapReduceGraphImpl implements AgentGraph {
  private executor: MapReduceExecutor;
  /** on() 注册的监听器，按 MultiAgentEvent.type 分发 */
  private bus = new SimpleEventBus();

  constructor(mapper: AgentNode, reducer: AgentNode, opts: MapReduceOpts) {
    this.executor = new MapReduceExecutor(mapper, reducer, opts);
  }

  addNode(): this { throw new Error('MapReduce 模式不支持手动 addNode'); }
  addEdge(): this { throw new Error('MapReduce 模式不支持手动 addEdge'); }
  setEntry(): this { throw new Error('MapReduce 模式不支持 setEntry'); }
  setFinish(): this { throw new Error('MapReduce 模式不支持 setFinish'); }

  async run(input: string | Request): Promise<MultiAgentResult> {
    this.executor.setEventSink(event => this.bus.emit(event.type, event));
    return this.executor.run(input);
  }

  async *stream(input: string | Request): AsyncGenerator<MultiAgentEvent> {
    this.executor.setEventSink(event => this.bus.emit(event.type, event));
    yield* this.executor.stream(input);
  }

  getState() { return this.executor.getState(); }
  abort(): void { this.executor.abort(); }

  on(event: string, listener: EventListener): this {
    this.bus.on(event, listener);
    return this;
  }
}

// ─── createMapReduce 工厂函数 ────────────────────────────────────

/**
 * 创建 MapReduce 并行聚合模式
 *
 * @param mapper - 映射方 Agent（处理单个子任务）
 * @param reducer - 汇总方 Agent（合并所有 mapper 结果）
 * @param opts - MapReduce 配置选项（必须提供 split 函数）
 * @returns AgentGraph 实例
 */
export function createMapReduce(
  mapper: AgentNode,
  reducer: AgentNode,
  opts: MapReduceOpts,
): AgentGraph {
  return new MapReduceGraphImpl(mapper, reducer, opts);
}
