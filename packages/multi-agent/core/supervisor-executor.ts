/**
 * core/supervisor-executor.ts - Supervisor 执行器
 *
 * 实现 Supervisor 层级委派模式：
 * 1. Supervisor Agent 先执行，拆解任务并写入 SharedContext
 * 2. Worker Agents 根据调度策略执行（parallel / sequential / auto）
 * 3. 汇总所有 Worker 结果
 */

import type { Result, Request } from '@aipack-ai/agent';
import type {
  AgentNode,
  SharedContext,
  MultiAgentResult,
  MultiAgentEvent,
  SupervisorOpts,
  ScheduleMode,
  NodeExecutionState,
  GraphExecutionState,
} from './types';
import { createSharedContext } from './context';
import { executeNode } from './executor';

// ─── SupervisorExecutor ──────────────────────────────────────────

export class SupervisorExecutor {
  private supervisorNode: AgentNode;
  private workerNodes: AgentNode[];
  private opts: Required<SupervisorOpts>;
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
    };

    // 初始化状态
    this.state.nodeStates.set(supervisor.id, 'pending');
    for (const w of workers) {
      this.state.nodeStates.set(w.id, 'pending');
    }
  }

  getState(): GraphExecutionState {
    return { ...this.state };
  }

  /** 执行 Supervisor 模式 */
  async run(input: string | Request): Promise<MultiAgentResult> {
    const ctx = createSharedContext({
      meta: { traceId: `sv-${Date.now()}`, startTime: Date.now() },
    });

    // 存储原始输入到 blackboard
    if (this.opts.passOriginalInput) {
      const inputText = typeof input === 'string' ? input : input.message;
      ctx.blackboard.set('__original_input__', inputText);
    }

    try {
      return await this.executeSupervisor(input, ctx, () => {});
    } catch (err) {
      return this.buildErrorResult(ctx, err);
    }
  }

  /** 流式执行 Supervisor 模式 */
  async *stream(input: string | Request): AsyncGenerator<MultiAgentEvent> {
    const ctx = createSharedContext({
      meta: { traceId: `sv-${Date.now()}`, startTime: Date.now() },
    });

    if (this.opts.passOriginalInput) {
      const inputText = typeof input === 'string' ? input : input.message;
      ctx.blackboard.set('__original_input__', inputText);
    }

    const eventQueue: MultiAgentEvent[] = [];
    let resolveEvent: (() => void) | null = null;
    let done = false;

    const emit = (event: MultiAgentEvent) => {
      eventQueue.push(event);
      resolveEvent?.();
    };

    const graphPromise = this.executeSupervisor(input, ctx, emit).then(
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
  private async executeSupervisor(
    input: string | Request,
    ctx: SharedContext,
    emit: (event: MultiAgentEvent) => void,
  ): Promise<MultiAgentResult> {
    let stepsCompleted = 0;
    const totalUsage: Record<string, number> = {};

    // ── Step 1: 执行 Supervisor ────────────────────────────────
    this.state.currentAgentId = this.supervisorNode.id;
    this.state.nodeStates.set(this.supervisorNode.id, 'running');
    emit({ type: 'agent_start', agentId: this.supervisorNode.id, agentName: this.supervisorNode.name });

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
    // 找到最后一个完成的 worker 的结果作为最终结果
    const lastWorkerId = this.workerNodes[this.workerNodes.length - 1].id;
    const finalResult = workerResults.get(lastWorkerId) ?? supervisorResult;

    this.state.finished = true;
    return {
      content: finalResult.content,
      lastAgentId: lastWorkerId,
      agentResults: new Map(this.state.nodeResults),
      totalUsage,
      stepsCompleted,
      stopReason: 'completed',
      context: ctx,
      success: true,
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

    emit({ type: 'parallel_start', agentIds: workers.map(w => w.id) });

    if (concurrency >= workers.length) {
      // 无限制并发，全部并行
      const promises = workers.map(async (worker) => {
        return this.executeWorker(worker, ctx, emit, totalUsage);
      });
      const settled = await Promise.allSettled(promises);
      for (let i = 0; i < settled.length; i++) {
        const s = settled[i];
        if (s.status === 'fulfilled') {
          results.set(workers[i].id, s.value);
        }
        // rejected 的已经在 executeWorker 中处理了
      }
    } else {
      // 限制并发数
      let index = 0;
      const executing = new Set<Promise<Result>>();

      const enqueue = (): Promise<Result> | null => {
        if (index >= workers.length) return null;
        const worker = workers[index++];
        const p = this.executeWorker(worker, ctx, emit, totalUsage).then(r => {
          results.set(worker.id, r);
          executing.delete(p);
          return r;
        });
        executing.add(p);
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

    for (const worker of this.workerNodes) {
      const result = await this.executeWorker(worker, ctx, emit, totalUsage);
      results.set(worker.id, result);
    }

    return results;
  }

  /** 自动调度：根据 inputMapping 依赖分层执行 */
  private async executeWorkersAuto(
    ctx: SharedContext,
    emit: (event: MultiAgentEvent) => void,
    totalUsage: Record<string, number>,
  ): Promise<Map<string, Result>> {
    const results = new Map<string, Result>();

    // 简化 auto 策略：
    // - 没有 inputMapping 的 worker（只依赖 supervisor 输出）→ 第一批并行
    // - 有 inputMapping 的 worker（可能依赖其他 worker 结果）→ 第二批顺序执行
    const noInputMapping = this.workerNodes.filter(w => !w.inputMapping);
    const withInputMapping = this.workerNodes.filter(w => !!w.inputMapping);

    // 第一批：并行执行无 inputMapping 的 worker
    if (noInputMapping.length > 0) {
      emit({ type: 'parallel_start', agentIds: noInputMapping.map(w => w.id) });
      const batchResults = await Promise.all(
        noInputMapping.map(w => this.executeWorker(w, ctx, emit, totalUsage)),
      );
      for (let i = 0; i < noInputMapping.length; i++) {
        results.set(noInputMapping[i].id, batchResults[i]);
      }
      emit({ type: 'parallel_done', results: new Map(results) });
    }

    // 第二批：顺序执行有 inputMapping 的 worker
    for (const worker of withInputMapping) {
      const result = await this.executeWorker(worker, ctx, emit, totalUsage);
      results.set(worker.id, result);
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
    this.state.currentAgentId = worker.id;
    this.state.nodeStates.set(worker.id, 'running');
    emit({ type: 'agent_start', agentId: worker.id, agentName: worker.name });

    try {
      // 解析输入：优先 inputMapping，否则用 supervisor 的输出
      let workerInput: string | Request;
      if (worker.inputMapping) {
        workerInput = worker.inputMapping(ctx);
      } else {
        // 从 blackboard 获取 supervisor 分配给该 worker 的任务
        const tasks = ctx.blackboard.get('tasks') as Array<{ assignee: string; task: string }> | undefined;
        const myTask = tasks?.find(t => t.assignee === worker.id);
        workerInput = myTask ? myTask.task : (ctx.blackboard.get('__original_input__') as string ?? '');
      }

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
    return {
      content: '',
      lastAgentId: this.supervisorNode.id,
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
