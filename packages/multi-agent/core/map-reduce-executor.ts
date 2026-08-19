/**
 * core/map-reduce-executor.ts - MapReduce 并行聚合执行器
 *
 * 实现 MapReduce 模式：
 * 1. split：将输入拆分为多个子任务
 * 2. map：用 mapper Agent 并行处理每个子任务
 * 3. reduce：用 reducer Agent 汇总所有 mapper 结果
 */

import type { Result, Request } from '@aipack-ai/agent';
import type {
  AgentNode,
  SharedContext,
  MultiAgentResult,
  MultiAgentEvent,
  MapReduceOpts,
  GraphExecutionState,
} from './types';
import { createSharedContext } from './context';
import { executeNode } from './executor';

// ─── MapReduceExecutor ───────────────────────────────────────────

export class MapReduceExecutor {
  private mapperNode: AgentNode;
  private reducerNode: AgentNode;
  private split: (input: string) => string[];
  private concurrency: number;
  private reduceInputFormat: (mapperResults: Map<number, Result>) => string;
  private state: GraphExecutionState = {
    nodeStates: new Map(),
    nodeResults: new Map(),
    stepsCompleted: 0,
    finished: false,
  };

  constructor(mapper: AgentNode, reducer: AgentNode, opts: MapReduceOpts) {
    this.mapperNode = mapper;
    this.reducerNode = reducer;
    this.split = opts.split;
    this.concurrency = opts.concurrency ?? Infinity;
    this.reduceInputFormat = opts.reduceInputFormat ?? ((mapperResults) => {
      const parts: string[] = [];
      for (const [idx, result] of mapperResults) {
        parts.push(`--- 子任务 ${idx + 1} ---\n${result.content}`);
      }
      return parts.join('\n\n');
    });

    this.state.nodeStates.set(mapper.id, 'pending');
    this.state.nodeStates.set(reducer.id, 'pending');
  }

  getState(): GraphExecutionState {
    return { ...this.state };
  }

  /** 执行 MapReduce */
  async run(input: string | Request): Promise<MultiAgentResult> {
    // 前置校验：split 结果
    const inputText = typeof input === 'string' ? input : input.message;
    const chunks = this.split(inputText);
    if (chunks.length === 0) {
      throw new Error('MapReduce: split 函数返回了空数组，至少需要一个子任务');
    }

    const ctx = createSharedContext({
      meta: { traceId: `mr-${Date.now()}`, startTime: Date.now() },
    });

    try {
      return await this.executeMapReduce(input, ctx, () => {});
    } catch (err) {
      return this.buildErrorResult(ctx, err);
    }
  }

  /** 流式执行 MapReduce */
  async *stream(input: string | Request): AsyncGenerator<MultiAgentEvent> {
    // 前置校验
    const inputText = typeof input === 'string' ? input : input.message;
    const chunks = this.split(inputText);
    if (chunks.length === 0) {
      throw new Error('MapReduce: split 函数返回了空数组，至少需要一个子任务');
    }

    const ctx = createSharedContext({
      meta: { traceId: `mr-${Date.now()}`, startTime: Date.now() },
    });

    const eventQueue: MultiAgentEvent[] = [];
    let resolveEvent: (() => void) | null = null;
    let done = false;

    const emit = (event: MultiAgentEvent) => {
      eventQueue.push(event);
      resolveEvent?.();
    };

    const graphPromise = this.executeMapReduce(input, ctx, emit).then(
      (result) => { emit({ type: 'graph_done', result }); },
      (err) => { emit({ type: 'graph_error', error: err instanceof Error ? err.message : String(err) }); },
    ).finally(() => {
      done = true;
      resolveEvent?.();
    });

    while (!done || eventQueue.length > 0) {
      if (eventQueue.length > 0) {
        yield eventQueue.shift()!;
      } else {
        await new Promise<void>(resolve => { resolveEvent = resolve; });
      }
    }

    await graphPromise;
  }

  /** 核心执行逻辑 */
  private async executeMapReduce(
    input: string | Request,
    ctx: SharedContext,
    emit: (event: MultiAgentEvent) => void,
  ): Promise<MultiAgentResult> {
    let stepsCompleted = 0;
    const totalUsage: Record<string, number> = {};
    const inputText = typeof input === 'string' ? input : input.message;

    // ── Step 1: Split ──────────────────────────────────────────
    const chunks = this.split(inputText);
    // 校验已在 run()/stream() 中完成

    // ── Step 2: Map（并行执行 mapper） ─────────────────────────
    const mapperResults = new Map<number, Result>();
    this.state.nodeStates.set(this.mapperNode.id, 'running');

    // 为每个子任务生成虚拟 ID
    const mapperAgentIds = chunks.map((_, i) => `${this.mapperNode.id}_${i}`);
    emit({ type: 'parallel_start', agentIds: mapperAgentIds });

    if (this.concurrency >= chunks.length) {
      // 无限制并发
      const promises = chunks.map(async (chunk, index) => {
        emit({ type: 'agent_start', agentId: `${this.mapperNode.id}_${index}`, agentName: `${this.mapperNode.name}#${index + 1}` });
        try {
          const result = await executeNode(this.mapperNode, chunk, ctx);
          this.state.nodeResults.set(`${this.mapperNode.id}_${index}`, result);
          this.mergeUsage(totalUsage, result.usage);
          stepsCompleted++;
          this.state.stepsCompleted = stepsCompleted;
          emit({ type: 'agent_result', agentId: `${this.mapperNode.id}_${index}`, agentName: `${this.mapperNode.name}#${index + 1}`, result });
          return { index, result };
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          emit({ type: 'agent_error', agentId: `${this.mapperNode.id}_${index}`, agentName: `${this.mapperNode.name}#${index + 1}`, error: errorMsg });
          throw err;
        }
      });

      const settled = await Promise.allSettled(promises);
      for (const s of settled) {
        if (s.status === 'fulfilled') {
          mapperResults.set(s.value.index, s.value.result);
        }
      }
    } else {
      // 限制并发数
      let index = 0;
      const executing = new Set<Promise<void>>();

      const enqueue = (): Promise<void> | null => {
        if (index >= chunks.length) return null;
        const currentIndex = index++;
        const chunk = chunks[currentIndex];

        const p = (async () => {
          emit({ type: 'agent_start', agentId: `${this.mapperNode.id}_${currentIndex}`, agentName: `${this.mapperNode.name}#${currentIndex + 1}` });
          try {
            const result = await executeNode(this.mapperNode, chunk, ctx);
            mapperResults.set(currentIndex, result);
            this.state.nodeResults.set(`${this.mapperNode.id}_${currentIndex}`, result);
            this.mergeUsage(totalUsage, result.usage);
            stepsCompleted++;
            this.state.stepsCompleted = stepsCompleted;
            emit({ type: 'agent_result', agentId: `${this.mapperNode.id}_${currentIndex}`, agentName: `${this.mapperNode.name}#${currentIndex + 1}`, result });
          } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            emit({ type: 'agent_error', agentId: `${this.mapperNode.id}_${currentIndex}`, agentName: `${this.mapperNode.name}#${currentIndex + 1}`, error: errorMsg });
            throw err;
          }
        })();

        executing.add(p);
        p.finally(() => executing.delete(p));
        return p;
      };

      for (let i = 0; i < this.concurrency && index < chunks.length; i++) {
        enqueue();
      }

      while (executing.size > 0) {
        await Promise.race(executing);
        enqueue();
      }
    }

    this.state.nodeStates.set(this.mapperNode.id, 'completed');
    const mapperResultsForEmit = new Map<string, Result>();
    for (const [idx, result] of mapperResults) {
      mapperResultsForEmit.set(`${this.mapperNode.id}_${idx}`, result);
    }
    emit({ type: 'parallel_done', results: mapperResultsForEmit });

    // 将 mapper 结果写入 blackboard
    ctx.blackboard.set('mapper_results', mapperResults);

    // ── Step 3: Reduce ─────────────────────────────────────────
    const reduceInput = this.reduceInputFormat(mapperResults);

    this.state.currentAgentId = this.reducerNode.id;
    this.state.nodeStates.set(this.reducerNode.id, 'running');
    emit({ type: 'agent_start', agentId: this.reducerNode.id, agentName: this.reducerNode.name });

    let reducerResult: Result;
    try {
      reducerResult = await executeNode(this.reducerNode, reduceInput, ctx);
      this.state.nodeStates.set(this.reducerNode.id, 'completed');
      this.state.nodeResults.set(this.reducerNode.id, reducerResult);
      this.mergeUsage(totalUsage, reducerResult.usage);
      stepsCompleted++;
      this.state.stepsCompleted = stepsCompleted;
      emit({ type: 'agent_result', agentId: this.reducerNode.id, agentName: this.reducerNode.name, result: reducerResult });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.state.nodeStates.set(this.reducerNode.id, 'failed');
      emit({ type: 'agent_error', agentId: this.reducerNode.id, agentName: this.reducerNode.name, error: errorMsg });
      throw err;
    }

    this.state.finished = true;
    return {
      content: reducerResult.content,
      lastAgentId: this.reducerNode.id,
      agentResults: new Map(this.state.nodeResults),
      totalUsage,
      stepsCompleted,
      stopReason: 'completed',
      context: ctx,
      success: true,
    };
  }

  private buildErrorResult(ctx: SharedContext, err: unknown): MultiAgentResult {
    this.state.finished = true;
    return {
      content: '',
      lastAgentId: this.mapperNode.id,
      agentResults: new Map(this.state.nodeResults),
      totalUsage: {},
      stepsCompleted: this.state.stepsCompleted,
      stopReason: 'error',
      context: ctx,
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  private mergeUsage(total: Record<string, number>, usage: Record<string, number>): void {
    for (const [key, value] of Object.entries(usage)) {
      total[key] = (total[key] ?? 0) + value;
    }
  }
}
