/**
 * core/map-reduce-executor.ts - MapReduce 并行聚合执行器
 *
 * 实现 MapReduce 模式：
 * 1. split：将输入拆分为多个子任务
 * 2. map：用 mapper Agent 并行处理每个子任务
 * 3. reduce：用 reducer Agent 汇总所有 mapper 结果
 *
 * 失败策略（onMapperError）：
 * - 'fail-fast'（默认）：任一子任务失败立即中止，整体返回 error
 * - 'skip'：容忍失败，仅汇总成功的子任务，结果暴露 failedAgents 与 stopReason='partial_failure'
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
import { createSharedContext, storeOriginalInput } from './context';
import { executeNode, GraphAbortedError } from './executor';
import { createEventStream } from './event-stream';
// ─── MapReduceExecutor ───────────────────────────────────────────

export class MapReduceExecutor {
  private mapperNode: AgentNode;
  private reducerNode: AgentNode;
  private split: (input: string) => string[];
  private concurrency: number;
  private onMapperError: 'fail-fast' | 'skip';
  private reduceInputFormat: (mapperResults: Map<number, Result>) => string;
  private abortController = new AbortController();
  /** 外部事件监听（on() API 的底层接线） */
  private eventSink?: (event: MultiAgentEvent) => void;
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
    this.onMapperError = opts.onMapperError ?? 'fail-fast';
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
    // 深拷贝快照：防止外部通过返回值篡改内部状态
    return {
      ...this.state,
      nodeStates: new Map(this.state.nodeStates),
      nodeResults: new Map(this.state.nodeResults),
    };
  }

  /** 注入外部事件监听（由 AgentGraph 实现的 on() 接线） */
  setEventSink(sink?: (event: MultiAgentEvent) => void): this {
    this.eventSink = sink;
    return this;
  }

  abort(): void {
    this.abortController.abort();
  }

  /** 每次 run/stream 前重置中止信号与执行状态 */
  private resetAbortController(): void {
    this.abortController = new AbortController();
    this.state = {
      nodeStates: new Map(),
      nodeResults: new Map(),
      stepsCompleted: 0,
      finished: false,
    };
    this.state.nodeStates.set(this.mapperNode.id, 'pending');
    this.state.nodeStates.set(this.reducerNode.id, 'pending');
  }

  private throwIfAborted(): void {
    if (this.abortController.signal.aborted) {
      throw new GraphAbortedError();
    }
  }

  /** 拆分输入并校验（每次 run/stream 只调用一次 split，避免副作用放大） */
  private splitInput(input: string | Request): string[] {
    const inputText = typeof input === 'string' ? input : input.message;
    const chunks = this.split(inputText);
    if (chunks.length === 0) {
      throw new Error('MapReduce: split 函数返回了空数组，至少需要一个子任务');
    }
    return chunks;
  }

  /** 执行 MapReduce */
  async run(input: string | Request): Promise<MultiAgentResult> {
    this.resetAbortController();
    const chunks = this.splitInput(input);

    const ctx = createSharedContext({
      meta: { traceId: `mr-${Date.now()}`, startTime: Date.now() },
    });
    storeOriginalInput(ctx, input);

    const emit = this.eventSink ?? (() => {});

    try {
      const result = await this.executeMapReduce(chunks, ctx, emit);
      emit({ type: 'graph_done', result });
      return result;
    } catch (err) {
      const result = this.buildErrorResult(ctx, err);
      emit({ type: 'graph_error', error: result.error ?? '' });
      return result;
    }
  }

  /** 流式执行 MapReduce */
  stream(input: string | Request): AsyncGenerator<MultiAgentEvent> {
    this.resetAbortController();
    const chunks = this.splitInput(input);

    const ctx = createSharedContext({
      meta: { traceId: `mr-${Date.now()}`, startTime: Date.now() },
    });
    storeOriginalInput(ctx, input);

    return createEventStream(
      emit => this.executeMapReduce(chunks, ctx, emit).then(
        (result) => { emit({ type: 'graph_done', result }); },
        (err) => {
          this.state.error = err instanceof Error ? err.message : String(err);
          emit({ type: 'graph_error', error: this.state.error });
        },
      ),
      this.eventSink,
    );
  }

  /** 核心执行逻辑 */
  private async executeMapReduce(
    chunks: string[],
    ctx: SharedContext,
    emit: (event: MultiAgentEvent) => void,
  ): Promise<MultiAgentResult> {
    const totalUsage: Record<string, number> = {};

    this.throwIfAborted();

    // ── Step 1+2: Map（并行执行 mapper，split 已在外层完成） ──
    this.state.nodeStates.set(this.mapperNode.id, 'running');
    // 为每个子任务登记虚拟节点状态（与 nodeResults 的虚拟 ID 对齐）
    chunks.forEach((_, i) => {
      this.state.nodeStates.set(`${this.mapperNode.id}_${i}`, 'pending');
    });

    const { results: mapperResults, failed } = await this.runMappers(chunks, ctx, emit, totalUsage);

    let stepsCompleted = mapperResults.size + failed.length;
    this.state.stepsCompleted = stepsCompleted;

    this.state.nodeStates.set(this.mapperNode.id, 'completed');
    const mapperResultsForEmit = new Map<string, Result>();
    for (const [idx, result] of mapperResults) {
      mapperResultsForEmit.set(`${this.mapperNode.id}_${idx}`, result);
    }
    emit({ type: 'parallel_done', results: mapperResultsForEmit });

    // 将 mapper 结果写入 blackboard
    ctx.blackboard.set('mapper_results', mapperResults);

    if (failed.length > 0 && mapperResults.size === 0) {
      throw new Error(`MapReduce: 所有 mapper 均失败（${failed.length}/${chunks.length}）`);
    }

    // ── Step 3: Reduce ─────────────────────────────────────────
    const reduceInput = this.reduceInputFormat(mapperResults);

    this.throwIfAborted();
    this.state.currentAgentId = this.reducerNode.id;
    this.state.nodeStates.set(this.reducerNode.id, 'running');
    emit({ type: 'agent_start', agentId: this.reducerNode.id, agentName: this.reducerNode.name, input: reduceInput });

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
    const hasFailures = failed.length > 0;
    return {
      content: reducerResult.content,
      lastAgentId: this.reducerNode.id,
      agentResults: new Map(this.state.nodeResults),
      totalUsage,
      stepsCompleted,
      stopReason: hasFailures ? 'partial_failure' : 'completed',
      context: ctx,
      success: true,
      ...(hasFailures ? { failedAgents: failed } : {}),
    };
  }

  /** 并行执行所有 mapper 子任务（统一处理并发限制与失败策略） */
  private async runMappers(
    chunks: string[],
    ctx: SharedContext,
    emit: (event: MultiAgentEvent) => void,
    totalUsage: Record<string, number>,
  ): Promise<{ results: Map<number, Result>; failed: string[] }> {
    const results = new Map<number, Result>();
    const failed: string[] = [];
    const skip = this.onMapperError === 'skip';
    const mapperId = this.mapperNode.id;

    const mapperAgentIds = chunks.map((_, i) => `${mapperId}_${i}`);
    emit({ type: 'parallel_start', agentIds: mapperAgentIds });

    const runOne = async (index: number): Promise<void> => {
      const agentId = `${mapperId}_${index}`;
      const agentName = `${this.mapperNode.name}#${index + 1}`;
      emit({ type: 'agent_start', agentId, agentName, input: chunks[index] });
      this.state.nodeStates.set(agentId, 'running');
      try {
        const result = await executeNode(this.mapperNode, chunks[index], ctx);
        this.state.nodeResults.set(agentId, result);
        this.state.nodeStates.set(agentId, 'completed');
        this.mergeUsage(totalUsage, result.usage);
        results.set(index, result);
        emit({ type: 'agent_result', agentId, agentName, result });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        this.state.nodeStates.set(agentId, 'failed');
        emit({ type: 'agent_error', agentId, agentName, error: errorMsg });
        if (!skip) throw err;
        failed.push(agentId);
      }
    };

    if (this.concurrency >= chunks.length) {
      // 无限制并发
      const promises = chunks.map((_, i) => runOne(i));
      if (!skip) {
        await Promise.all(promises);
      } else {
        // runOne 在 skip 模式下不会 reject，allSettled 仅作双保险
        await Promise.allSettled(promises);
      }
    } else {
      // 限制并发数
      let index = 0;
      const executing = new Set<Promise<void>>();

      const enqueue = (): Promise<void> | null => {
        if (index >= chunks.length) return null;
        const i = index++;
        const p: Promise<void> = runOne(i).finally(() => { executing.delete(p); });
        executing.add(p);
        // 防止 fail-fast 提前退出后，仍在运行的 promise 触发 unhandledRejection
        p.catch(() => {});
        return p;
      };

      // 初始填充
      for (let i = 0; i < this.concurrency && index < chunks.length; i++) {
        enqueue();
      }

      while (executing.size > 0) {
        await Promise.race(executing);
        enqueue();
      }
    }

    return { results, failed };
  }

  private buildErrorResult(ctx: SharedContext, err: unknown): MultiAgentResult {
    this.state.finished = true;
    const aborted = err instanceof GraphAbortedError;
    const errorMsg = err instanceof Error ? err.message : String(err);
    this.state.error = errorMsg;
    const lastCompleted = [...this.state.nodeResults.values()].at(-1);
    return {
      content: aborted ? (lastCompleted?.content ?? '') : '',
      lastAgentId: this.mapperNode.id,
      agentResults: new Map(this.state.nodeResults),
      totalUsage: {},
      stepsCompleted: this.state.stepsCompleted,
      stopReason: aborted ? 'aborted' : 'error',
      context: ctx,
      success: false,
      error: errorMsg,
    };
  }

  private mergeUsage(total: Record<string, number>, usage: Record<string, number>): void {
    for (const [key, value] of Object.entries(usage)) {
      total[key] = (total[key] ?? 0) + value;
    }
  }
}
