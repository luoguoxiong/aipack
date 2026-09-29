/**
 * core/supervisor-executor.ts - Supervisor 执行器
 *
 * 实现 Supervisor 层级委派模式：
 * 1. Supervisor Agent 先执行，拆解任务并写入 SharedContext
 * 2. Worker Agents 根据调度策略执行（parallel / sequential / auto）
 * 3. 汇总所有 Worker 结果
 *
 * 失败策略（onWorkerError）：
 * - 'fail-fast'（默认）：任一 Worker 失败立即中止，整体返回 error
 * - 'skip'：容忍失败，跳过失败 Worker，结果暴露 failedAgents 与 stopReason='partial_failure'
 */

import type { Result, Request } from '@aipack-ai/agent';
import type {
  AgentNode,
  SharedContext,
  MultiAgentResult,
  MultiAgentEvent,
  SupervisorOpts,
  GraphExecutionState,
} from './types';
import { createSharedContext, storeOriginalInput } from './context';
import { executeNode, GraphAbortedError, toInputText } from './executor';
import { createEventStream } from './event-stream';

// ─── SupervisorExecutor ──────────────────────────────────────────

export class SupervisorExecutor {
  private supervisorNode: AgentNode;
  private workerNodes: AgentNode[];
  private opts: Required<Omit<SupervisorOpts, 'onWorkerError'>> & {
    onWorkerError: NonNullable<SupervisorOpts['onWorkerError']>;
  };
  private abortController = new AbortController();
  /** 外部事件监听（on() API 的底层接线） */
  private eventSink?: (event: MultiAgentEvent) => void;
  /** 最近一次 run 中失败的 Worker ID（onWorkerError='skip' 时使用） */
  private failedAgents: string[] = [];
  private state: GraphExecutionState = {
    nodeStates: new Map(),
    nodeResults: new Map(),
    stepsCompleted: 0,
    finished: false,
  };

  constructor(supervisor: AgentNode, workers: AgentNode[], opts?: SupervisorOpts) {
    this.supervisorNode = supervisor;
    this.workerNodes = workers;
    this.opts = {
      schedule: opts?.schedule ?? 'parallel',
      concurrency: opts?.concurrency ?? Infinity,
      passOriginalInput: opts?.passOriginalInput ?? true,
      onWorkerError: opts?.onWorkerError ?? 'fail-fast',
    };

    // 初始化状态
    this.state.nodeStates.set(supervisor.id, 'pending');
    for (const w of workers) {
      this.state.nodeStates.set(w.id, 'pending');
    }
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

  /** 每次 run/stream 前重置中止信号、失败记录与执行状态 */
  private resetRun(): void {
    this.abortController = new AbortController();
    this.failedAgents = [];
    this.state = {
      nodeStates: new Map(),
      nodeResults: new Map(),
      stepsCompleted: 0,
      finished: false,
    };
    this.state.nodeStates.set(this.supervisorNode.id, 'pending');
    for (const w of this.workerNodes) {
      this.state.nodeStates.set(w.id, 'pending');
    }
  }

  private throwIfAborted(): void {
    if (this.abortController.signal.aborted) {
      throw new GraphAbortedError();
    }
  }

  /** 执行 Supervisor 模式 */
  async run(input: string | Request): Promise<MultiAgentResult> {
    this.resetRun();
    const ctx = createSharedContext({
      meta: { traceId: `sv-${Date.now()}`, startTime: Date.now() },
    });

    // 存储原始输入到 blackboard
    if (this.opts.passOriginalInput) {
      storeOriginalInput(ctx, input);
    }

    const emit = this.eventSink ?? (() => {});

    try {
      const result = await this.executeSupervisor(input, ctx, emit);
      emit({ type: 'graph_done', result });
      return result;
    } catch (err) {
      const result = this.buildErrorResult(ctx, err);
      emit({ type: 'graph_error', error: result.error ?? '' });
      return result;
    }
  }

  /** 流式执行 Supervisor 模式 */
  stream(input: string | Request): AsyncGenerator<MultiAgentEvent> {
    this.resetRun();
    const ctx = createSharedContext({
      meta: { traceId: `sv-${Date.now()}`, startTime: Date.now() },
    });

    if (this.opts.passOriginalInput) {
      storeOriginalInput(ctx, input);
    }

    return createEventStream(
      emit => this.executeSupervisor(input, ctx, emit).then(
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
  private async executeSupervisor(
    input: string | Request,
    ctx: SharedContext,
    emit: (event: MultiAgentEvent) => void,
  ): Promise<MultiAgentResult> {
    let stepsCompleted = 0;
    const totalUsage: Record<string, number> = {};

    // ── Step 1: 执行 Supervisor ────────────────────────────────
    this.throwIfAborted();
    this.state.currentAgentId = this.supervisorNode.id;
    this.state.nodeStates.set(this.supervisorNode.id, 'running');
    emit({ type: 'agent_start', agentId: this.supervisorNode.id, agentName: this.supervisorNode.name, input: toInputText(input) });

    let supervisorResult: Result;
    try {
      supervisorResult = await executeNode(this.supervisorNode, input, ctx);
      this.state.nodeStates.set(this.supervisorNode.id, 'completed');
      this.state.nodeResults.set(this.supervisorNode.id, supervisorResult);
      this.mergeUsage(totalUsage, supervisorResult.usage);
      stepsCompleted++;
      this.state.stepsCompleted = stepsCompleted;
      emit({ type: 'agent_result', agentId: this.supervisorNode.id, agentName: this.supervisorNode.name, result: supervisorResult });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.state.nodeStates.set(this.supervisorNode.id, 'failed');
      emit({ type: 'agent_error', agentId: this.supervisorNode.id, agentName: this.supervisorNode.name, error: errorMsg });
      throw err;
    }

    // ── Step 2: 调度 Worker 执行 ──────────────────────────────
    const schedule = this.opts.schedule;
    let workerResults: Map<string, Result>;

    if (schedule === 'parallel') {
      workerResults = await this.executeWorkersParallel(ctx, emit, totalUsage);
    } else if (schedule === 'sequential') {
      workerResults = await this.executeWorkersSequential(ctx, emit, totalUsage);
    } else {
      // auto: 分析依赖，分层执行
      workerResults = await this.executeWorkersAuto(ctx, emit, totalUsage);
    }

    stepsCompleted += workerResults.size;
    this.state.stepsCompleted = stepsCompleted;

    // ── Step 3: 汇总结果 ──────────────────────────────────────
    // 取最后一个完成的 worker 的结果作为最终结果（skip 模式下最后的 worker 可能失败，需回退）
    const lastEntry = [...workerResults.entries()].at(-1);
    const finalResult = lastEntry?.[1] ?? supervisorResult;
    const finalAgentId = lastEntry?.[0] ?? this.supervisorNode.id;

    const hasFailures = this.failedAgents.length > 0;

    this.state.finished = true;
    return {
      content: finalResult.content,
      lastAgentId: finalAgentId,
      agentResults: new Map(this.state.nodeResults),
      totalUsage,
      stepsCompleted,
      stopReason: hasFailures ? 'partial_failure' : 'completed',
      context: ctx,
      success: true,
      ...(hasFailures ? { failedAgents: [...this.failedAgents] } : {}),
    };
  }

  /** 并行执行所有 Worker */
  private async executeWorkersParallel(
    ctx: SharedContext,
    emit: (event: MultiAgentEvent) => void,
    totalUsage: Record<string, number>,
  ): Promise<Map<string, Result>> {
    const results = new Map<string, Result>();
    const workers = this.workerNodes;
    const concurrency = this.opts.concurrency;
    const skip = this.opts.onWorkerError === 'skip';

    emit({ type: 'parallel_start', agentIds: workers.map(w => w.id) });

    if (concurrency >= workers.length) {
      if (!skip) {
        // fail-fast：任一失败立即抛出
        await Promise.all(
          workers.map(async (worker) => {
            const r = await this.executeWorker(worker, ctx, emit, totalUsage);
            results.set(worker.id, r);
            return r;
          }),
        );
      } else {
        // skip：容忍失败
        const settled = await Promise.allSettled(
          workers.map(worker => this.executeWorker(worker, ctx, emit, totalUsage)),
        );
        for (let i = 0; i < settled.length; i++) {
          const s = settled[i];
          if (s.status === 'fulfilled') {
            results.set(workers[i].id, s.value);
          } else {
            this.failedAgents.push(workers[i].id);
          }
        }
      }
    } else {
      // 限制并发数
      let index = 0;
      const executing = new Set<Promise<void>>();

      const enqueue = (): Promise<void> | null => {
        if (index >= workers.length) return null;
        const worker = workers[index++];
        const p: Promise<void> = this.executeWorker(worker, ctx, emit, totalUsage).then(
          r => { results.set(worker.id, r); },
          err => {
            if (!skip) throw err;
            this.failedAgents.push(worker.id);
          },
        ).finally(() => { executing.delete(p); });
        executing.add(p);
        // 防止 fail-fast 提前退出后，仍在运行的 promise 触发 unhandledRejection
        p.catch(() => {});
        return p;
      };

      // 初始填充
      for (let i = 0; i < concurrency && index < workers.length; i++) {
        enqueue();
      }

      while (executing.size > 0) {
        await Promise.race(executing);
        enqueue();
      }
    }

    emit({ type: 'parallel_done', results });
    return results;
  }

  /** 顺序执行所有 Worker */
  private async executeWorkersSequential(
    ctx: SharedContext,
    emit: (event: MultiAgentEvent) => void,
    totalUsage: Record<string, number>,
  ): Promise<Map<string, Result>> {
    const results = new Map<string, Result>();
    const skip = this.opts.onWorkerError === 'skip';

    for (const worker of this.workerNodes) {
      try {
        const result = await this.executeWorker(worker, ctx, emit, totalUsage);
        results.set(worker.id, result);
      } catch (err) {
        if (!skip) throw err;
        this.failedAgents.push(worker.id);
      }
    }

    return results;
  }

  /** 自动调度：按依赖分层执行
   *
   * 依赖推导规则：
   * 1. 显式声明 dependsOn 的 worker：依赖指定的 worker（依赖必须都在 workers 列表中，否则报错）
   * 2. 未声明 dependsOn 但有 inputMapping 的 worker：隐式依赖所有"第 0 层"worker（保持向后兼容）
   * 3. 其余 worker（无 dependsOn 且无 inputMapping）：第 0 层，首批并行
   *
   * 按拓扑分层：同层并行执行（受 concurrency 限制），层间按序执行；依赖成环时报错。
   */
  private async executeWorkersAuto(
    ctx: SharedContext,
    emit: (event: MultiAgentEvent) => void,
    totalUsage: Record<string, number>,
  ): Promise<Map<string, Result>> {
    const results = new Map<string, Result>();
    const skip = this.opts.onWorkerError === 'skip';
    const workerIds = new Set(this.workerNodes.map(w => w.id));

    // 构建依赖表
    const layer0 = this.workerNodes.filter(w => !w.inputMapping && !w.dependsOn);
    const deps = new Map<string, Set<string>>();
    for (const w of this.workerNodes) {
      if (w.dependsOn) {
        for (const dep of w.dependsOn) {
          if (!workerIds.has(dep)) {
            throw new Error(`Supervisor: Worker "${w.id}" 的 dependsOn 引用了不存在的 Worker "${dep}"`);
          }
        }
        deps.set(w.id, new Set(w.dependsOn));
      } else if (w.inputMapping) {
        // 向后兼容：隐式依赖所有"第 0 层"worker
        deps.set(w.id, new Set(layer0.map(l => l.id)));
      } else {
        deps.set(w.id, new Set());
      }
    }

    // 拓扑分层（Kahn 变体：逐层挑出依赖已全部完成的节点）
    const remaining = new Map(deps);
    const layers: AgentNode[][] = [];
    const doneIds = new Set<string>();
    while (remaining.size > 0) {
      const layer: AgentNode[] = [];
      for (const [id, depSet] of remaining) {
        if ([...depSet].every(d => doneIds.has(d))) {
          layer.push(this.workerNodes.find(w => w.id === id)!);
        }
      }
      if (layer.length === 0) {
        throw new Error(`Supervisor: auto 调度的 Worker 依赖存在环（涉及: ${[...remaining.keys()].join(', ')}）`);
      }
      for (const w of layer) {
        remaining.delete(w.id);
        doneIds.add(w.id);
      }
      layers.push(layer);
    }

    // 逐层执行：层内并行（限流），层间顺序
    for (const layer of layers) {
      if (layer.length === 1) {
        try {
          const r = await this.executeWorker(layer[0], ctx, emit, totalUsage);
          results.set(layer[0].id, r);
        } catch (err) {
          if (!skip) throw err;
          this.failedAgents.push(layer[0].id);
        }
        continue;
      }

      emit({ type: 'parallel_start', agentIds: layer.map(w => w.id) });

      const runOne = async (worker: AgentNode): Promise<void> => {
        try {
          const r = await this.executeWorker(worker, ctx, emit, totalUsage);
          results.set(worker.id, r);
        } catch (err) {
          if (!skip) throw err;
          this.failedAgents.push(worker.id);
        }
      };

      if (this.opts.concurrency >= layer.length) {
        await Promise.all(layer.map(w => runOne(w)));
      } else {
        // 限流并发池
        let index = 0;
        const executing = new Set<Promise<void>>();
        const enqueue = (): Promise<void> | null => {
          if (index >= layer.length) return null;
          const i = index++;
          const p: Promise<void> = runOne(layer[i]).finally(() => { executing.delete(p); });
          executing.add(p);
          p.catch(() => {}); // fail-fast 提前退出后防 unhandledRejection
          return p;
        };
        for (let i = 0; i < this.opts.concurrency && index < layer.length; i++) {
          enqueue();
        }
        while (executing.size > 0) {
          await Promise.race(executing);
          enqueue();
        }
      }

      emit({ type: 'parallel_done', results: new Map(results) });
    }

    return results;
  }

  /** 执行单个 Worker */
  private async executeWorker(
    worker: AgentNode,
    ctx: SharedContext,
    emit: (event: MultiAgentEvent) => void,
    totalUsage: Record<string, number>,
  ): Promise<Result> {
    this.throwIfAborted();
    this.state.currentAgentId = worker.id;
    this.state.nodeStates.set(worker.id, 'running');

    // 解析输入：优先 inputMapping，否则用 supervisor 的输出
    let workerInput: string | Request;
    try {
      if (worker.inputMapping) {
        workerInput = worker.inputMapping(ctx);
      } else {
        // 从 blackboard 获取 supervisor 分配给该 worker 的任务
        const tasks = ctx.blackboard.get('tasks') as Array<{ assignee: string; task: string }> | undefined;
        const myTask = tasks?.find(t => t.assignee === worker.id);
        workerInput = myTask ? myTask.task : (ctx.blackboard.get('__original_input__') as string ?? '');
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.state.nodeStates.set(worker.id, 'failed');
      emit({ type: 'agent_error', agentId: worker.id, agentName: worker.name, error: errorMsg });
      throw err;
    }

    emit({ type: 'agent_start', agentId: worker.id, agentName: worker.name, input: toInputText(workerInput) });

    try {
      const result = await executeNode(worker, workerInput, ctx);
      this.state.nodeStates.set(worker.id, 'completed');
      this.state.nodeResults.set(worker.id, result);
      this.mergeUsage(totalUsage, result.usage);

      // 自动将 worker 结果写入 blackboard（方便后续 worker 读取）
      ctx.blackboard.set(`${worker.id}_result`, result.content);

      emit({ type: 'agent_result', agentId: worker.id, agentName: worker.name, result });
      return result;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.state.nodeStates.set(worker.id, 'failed');
      emit({ type: 'agent_error', agentId: worker.id, agentName: worker.name, error: errorMsg });
      throw err;
    }
  }

  private buildErrorResult(ctx: SharedContext, err: unknown): MultiAgentResult {
    this.state.finished = true;
    const aborted = err instanceof GraphAbortedError;
    const errorMsg = err instanceof Error ? err.message : String(err);
    this.state.error = errorMsg;
    const lastCompleted = [...this.state.nodeResults.values()].at(-1);
    return {
      content: aborted ? (lastCompleted?.content ?? '') : '',
      lastAgentId: this.state.currentAgentId ?? this.supervisorNode.id,
      agentResults: new Map(this.state.nodeResults),
      totalUsage: {},
      stepsCompleted: this.state.stepsCompleted,
      stopReason: aborted ? 'aborted' : 'error',
      context: ctx,
      success: false,
      error: errorMsg,
      ...(this.failedAgents.length > 0 ? { failedAgents: [...this.failedAgents] } : {}),
    };
  }

  private mergeUsage(total: Record<string, number>, usage: Record<string, number>): void {
    for (const [key, value] of Object.entries(usage)) {
      total[key] = (total[key] ?? 0) + value;
    }
  }
}
