/**
 * core/executor.ts - 图执行引擎
 *
 * 负责 AgentGraph 的执行逻辑：从入口节点出发，
 * 根据边条件遍历图，依次执行各节点的 Runtime。
 */

import type { Runtime, RuntimeOptions, Result, Request } from '@aipack-ai/agent';
import { createRuntime } from '@aipack-ai/agent';
import { createRequest } from '@aipack-ai/agent';
import type {
  AgentNode,
  AgentEdge,
  SharedContext,
  MultiAgentResult,
  MultiAgentEvent,
  NodeExecutionState,
  GraphExecutionState,
  GraphExecutionOpts,
} from './types';
import { createSharedContext, storeOriginalInput } from './context';
import { createEventStream } from './event-stream';

// ─── GraphAbortedError: 中止信号 ───────────────────────────────

/** abort() 触发的中止错误，run() 会将其转换为 stopReason='aborted' 的结果 */
export class GraphAbortedError extends Error {
  constructor() {
    super('AgentGraph: 执行已被中止');
    this.name = 'GraphAbortedError';
  }
}

// ─── toInputText: 提取输入文本（供事件摘要使用） ─────────────────

/** 将 string | Request 输入提取为文本（agent_start 事件的 input 摘要字段） */
export function toInputText(input: string | Request): string {
  return typeof input === 'string' ? input : input.message;
}

// ─── NodeTimeoutError: 节点超时 ─────────────────────────────────

/** 节点执行超时错误（timeoutMs 触发，可配合 retry 重试） */
export class NodeTimeoutError extends Error {
  constructor(nodeId: string, timeoutMs: number) {
    super(`AgentGraph: 节点 "${nodeId}" 执行超时（${timeoutMs}ms）`);
    this.name = 'NodeTimeoutError';
  }
}

// ─── ensureRuntime: 确保 AgentNode 拥有 Runtime 实例 ────────────

const runtimeCache = new WeakMap<AgentNode, Runtime>();

export function ensureRuntime(node: AgentNode): Runtime {
  let rt = runtimeCache.get(node);
  if (rt) return rt;

  if (typeof (node.runtime as Runtime).run === 'function') {
    rt = node.runtime as Runtime;
  } else {
    rt = createRuntime(node.runtime as RuntimeOptions);
  }
  runtimeCache.set(node, rt);
  return rt;
}

// ─── executeNode: 执行单个 Agent 节点 ───────────────────────────

/** 单次节点执行（不含重试） */
async function executeNodeOnce(
  node: AgentNode,
  req: Request,
): Promise<Result> {
  const runtime = ensureRuntime(node);

  if (node.timeoutMs != null && node.timeoutMs > 0) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        runtime.run(req),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new NodeTimeoutError(node.id, node.timeoutMs!)), node.timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  return runtime.run(req);
}

export async function executeNode(
  node: AgentNode,
  input: string | Request,
  ctx: SharedContext,
): Promise<Result> {
  // 构建 Request
  let req: Request;
  if (typeof input === 'string') {
    req = createRequest(input, { sessionKey: `multi-agent:${node.id}` });
  } else {
    req = { ...input, sessionKey: input.sessionKey ?? `multi-agent:${node.id}` };
  }

  // 重试循环（节点级 retry 配置，超时/失败均计入重试）
  const maxAttempts = Math.max(1, node.retry?.maxAttempts ?? 1);
  const backoffMs = node.retry?.backoffMs ?? 0;

  let lastErr: unknown;
  let succeeded: Result | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1 && backoffMs > 0) {
      await new Promise(resolve => setTimeout(resolve, backoffMs));
    }
    try {
      succeeded = await executeNodeOnce(node, req);
      break;
    } catch (err) {
      lastErr = err;
    }
  }

  if (succeeded === undefined) {
    throw lastErr;
  }

  // 输出映射
  if (node.outputMapping) {
    node.outputMapping(succeeded, ctx);
  }

  return succeeded;
}

// ─── resolveInput: 解析下一个节点的输入 ─────────────────────────

export function resolveInput(
  edge: AgentEdge | undefined,
  prevResult: Result,
  ctx: SharedContext,
  node: AgentNode,
  originalInput: string | Request,
): string | Request {
  // 优先级：edge.transform > node.inputMapping > 传递上一个结果
  if (edge?.transform) {
    return edge.transform(prevResult, ctx);
  }
  if (node.inputMapping) {
    return node.inputMapping(ctx);
  }
  return prevResult.content;
}

// ─── findNextEdges: 查找满足条件的出边 ─────────────────────────

export function findNextEdges(
  fromId: string,
  edges: AgentEdge[],
  result: Result,
  ctx: SharedContext,
): AgentEdge[] {
  const outEdges = edges.filter(e => e.from === fromId);
  const matched: AgentEdge[] = [];

  for (const edge of outEdges) {
    // 无条件边默认匹配
    if (!edge.condition || edge.condition(result, ctx)) {
      matched.push(edge);
    }
  }
  return matched;
}

// ─── GraphExecutor: 图执行器 ─────────────────────────────────────

export class GraphExecutor {
  private nodes: Map<string, AgentNode> = new Map();
  private edges: AgentEdge[] = [];
  private entryId?: string;
  private finishCondition?: (ctx: SharedContext) => boolean;
  private abortController = new AbortController();
  /** 外部事件监听（on() API 的底层接线），事件会同步分发 */
  private eventSink?: (event: MultiAgentEvent) => void;
  /** 并行分支最大并发数（默认不限制） */
  private concurrency: number;
  /** 单节点最大访问次数（环图防死循环） */
  private maxVisitsPerNode: number;
  private state: GraphExecutionState = {
    nodeStates: new Map(),
    nodeResults: new Map(),
    stepsCompleted: 0,
    finished: false,
  };

  constructor(opts?: GraphExecutionOpts) {
    this.concurrency = opts?.concurrency ?? Infinity;
    this.maxVisitsPerNode = opts?.maxVisitsPerNode ?? 10;
  }

  addNode(node: AgentNode): this {
    this.nodes.set(node.id, node);
    this.state.nodeStates.set(node.id, 'pending');
    return this;
  }

  addEdge(edge: AgentEdge): this {
    this.edges.push(edge);
    return this;
  }

  setEntry(agentId: string): this {
    this.entryId = agentId;
    return this;
  }

  setFinish(condition: (ctx: SharedContext) => boolean): this {
    this.finishCondition = condition;
    return this;
  }

  /** 注入外部事件监听（由 AgentGraph 实现的 on() 接线） */
  setEventSink(sink?: (event: MultiAgentEvent) => void): this {
    this.eventSink = sink;
    return this;
  }

  getState(): GraphExecutionState {
    // 深拷贝快照：防止外部通过返回值篡改内部状态
    return {
      ...this.state,
      nodeStates: new Map(this.state.nodeStates),
      nodeResults: new Map(this.state.nodeResults),
    };
  }

  abort(): void {
    this.abortController.abort();
  }

  /** 每次 run/stream 前重置中止信号，避免上一次的 abort 永久失效 */
  private resetAbortController(): void {
    this.abortController = new AbortController();
  }

  /** 每次 run/stream 前重置执行状态，避免残留上一次的 nodeStates/结果 */
  private resetState(): void {
    this.state = {
      nodeStates: new Map(),
      nodeResults: new Map(),
      stepsCompleted: 0,
      finished: false,
    };
    for (const id of this.nodes.keys()) {
      this.state.nodeStates.set(id, 'pending');
    }
  }

  private throwIfAborted(): void {
    if (this.abortController.signal.aborted) {
      throw new GraphAbortedError();
    }
  }

  /** 同步执行图 */
  async run(input: string | Request): Promise<MultiAgentResult> {
    // 前置校验：入口节点相关错误直接抛出
    if (!this.entryId) {
      throw new Error('AgentGraph: 入口节点未设置，请调用 setEntry()');
    }
    if (!this.nodes.has(this.entryId)) {
      throw new Error(`AgentGraph: 入口节点 "${this.entryId}" 不存在`);
    }

    this.resetAbortController();
    this.resetState();
    const ctx = createSharedContext({
      meta: { traceId: `ma-${Date.now()}`, startTime: Date.now() },
    });
    storeOriginalInput(ctx, input);
    const emit = this.eventSink ?? (() => {});

    try {
      const result = await this.executeGraph(input, ctx, emit);
      emit({ type: 'graph_done', result });
      return result;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.state.error = errorMsg;
      if (err instanceof GraphAbortedError) {
        // 中止：保留最后完成的节点输出
        const lastCompleted = [...this.state.nodeResults.values()].at(-1);
        const abortedResult: MultiAgentResult = {
          content: lastCompleted?.content ?? '',
          lastAgentId: this.state.currentAgentId ?? '',
          agentResults: new Map(this.state.nodeResults),
          totalUsage: {},
          stepsCompleted: this.state.stepsCompleted,
          stopReason: 'aborted',
          context: ctx,
          success: false,
          error: err.message,
        };
        emit({ type: 'graph_error', error: err.message });
        return abortedResult;
      }
      emit({ type: 'graph_error', error: errorMsg });
      return {
        content: '',
        lastAgentId: this.state.currentAgentId ?? '',
        agentResults: new Map(this.state.nodeResults),
        totalUsage: {},
        stepsCompleted: this.state.stepsCompleted,
        stopReason: 'error',
        context: ctx,
        success: false,
        error: errorMsg,
      };
    }
  }

  /** 流式执行图 */
  stream(input: string | Request): AsyncGenerator<MultiAgentEvent> {
    // 前置校验
    if (!this.entryId) {
      throw new Error('AgentGraph: 入口节点未设置，请调用 setEntry()');
    }
    if (!this.nodes.has(this.entryId)) {
      throw new Error(`AgentGraph: 入口节点 "${this.entryId}" 不存在`);
    }

    this.resetAbortController();
    this.resetState();
    const ctx = createSharedContext({
      meta: { traceId: `ma-${Date.now()}`, startTime: Date.now() },
    });
    storeOriginalInput(ctx, input);

    return createEventStream(
      emit => this.executeGraph(input, ctx, emit).then(
        (result) => { emit({ type: 'graph_done', result }); },
        (err) => {
          const errorMsg = err instanceof Error ? err.message : String(err);
          this.state.error = errorMsg;
          emit({ type: 'graph_error', error: errorMsg });
        },
      ),
      this.eventSink,
    );
  }

  /** 核心执行逻辑 */
  private async executeGraph(
    input: string | Request,
    ctx: SharedContext,
    emit: (event: MultiAgentEvent) => void,
  ): Promise<MultiAgentResult> {
    const entryNode = this.nodes.get(this.entryId!)!;

    let currentId = this.entryId!;
    let currentInput: string | Request = input;
    let lastResult: Result | undefined;
    let lastAgentId = currentId;
    let stepsCompleted = 0;
    const totalUsage: Record<string, number> = {};

    // 执行入口节点
    this.state.currentAgentId = currentId;
    this.state.nodeStates.set(currentId, 'running');
    emit({ type: 'agent_start', agentId: currentId, agentName: entryNode.name, input: toInputText(currentInput) });

    try {
      lastResult = await executeNode(entryNode, currentInput, ctx);
      this.state.nodeStates.set(currentId, 'completed');
      this.state.nodeResults.set(currentId, lastResult);
      this.mergeUsage(totalUsage, lastResult.usage);
      stepsCompleted++;
      this.state.stepsCompleted = stepsCompleted;
      emit({ type: 'agent_result', agentId: currentId, agentName: entryNode.name, result: lastResult });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.state.nodeStates.set(currentId, 'failed');
      emit({ type: 'agent_error', agentId: currentId, agentName: entryNode.name, error: errorMsg });
      throw err;
    }

    lastAgentId = currentId;

    // 检查终止条件
    if (this.finishCondition?.(ctx)) {
      return this.buildResult(lastResult!, lastAgentId, ctx, totalUsage, stepsCompleted, 'finish_condition');
    }

    // ── 沿边遍历（wave 模式：支持并行分支 fan-out） ─────────────
    // frontier：上一轮完成的节点，等待评估出边
    // 单条边匹配 → 顺序执行（与旧语义一致）
    // 多条边匹配 → 并行执行（受 concurrency 限制），发出 parallel_start/parallel_done
    let frontier: Array<{ id: string; result: Result }> = [{ id: currentId, result: lastResult }];
    // 允许环形（如review→coder），用计数防止无限循环
    const visitCount = new Map<string, number>();
    let stopReason = 'completed';

    while (frontier.length > 0) {
      // 中止检查：abort() 后不再遍历后续节点
      this.throwIfAborted();

      // 收集本 wave 的候选边（按 frontier 顺序，目标节点去重：同目标只执行一次，取首条入边）
      const candidates: Array<{ edge: AgentEdge; from: { id: string; result: Result }; node: AgentNode }> = [];
      const seenTargets = new Set<string>();
      for (const from of frontier) {
        const nextEdges = findNextEdges(from.id, this.edges, from.result, ctx);
        for (const edge of nextEdges) {
          if (seenTargets.has(edge.to)) continue;
          seenTargets.add(edge.to);
          const nextNode = this.nodes.get(edge.to);
          if (!nextNode) {
            throw new Error(`AgentGraph: 目标节点 "${edge.to}" 不存在`);
          }
          candidates.push({ edge, from, node: nextNode });
        }
      }

      if (candidates.length === 0) {
        // 无出边，图执行完毕
        break;
      }

      // 访问上限检查（安全阀，逐候选过滤）
      const allowed = [];
      let truncated = false;
      for (const c of candidates) {
        const count = (visitCount.get(c.edge.to) ?? 0) + 1;
        if (count > this.maxVisitsPerNode) {
          truncated = true;
          continue;
        }
        visitCount.set(c.edge.to, count);
        allowed.push(c);
      }
      if (allowed.length === 0) {
        // 安全截断而非正常完成，通过 stopReason 区分
        if (truncated) stopReason = 'max_visits_exceeded';
        break;
      }

      // 解析各候选的输入
      const tasks = allowed.map(c => ({
        node: c.node,
        input: resolveInput(c.edge, c.from.result, ctx, c.node, input),
        fromId: c.edge.from,
      }));

      // 执行本 wave
      let waveResults: Array<{ id: string; result: Result }>;
      if (tasks.length === 1) {
        // 单分支：顺序执行（保持与历史语义一致）
        const t = tasks[0];
        this.state.currentAgentId = t.node.id;
        this.state.nodeStates.set(t.node.id, 'running');
        emit({ type: 'edge_traversed', from: t.fromId, to: t.node.id });
        emit({ type: 'agent_start', agentId: t.node.id, agentName: t.node.name, input: toInputText(t.input) });
        let result: Result;
        try {
          result = await executeNode(t.node, t.input, ctx);
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          this.state.nodeStates.set(t.node.id, 'failed');
          emit({ type: 'agent_error', agentId: t.node.id, agentName: t.node.name, error: errorMsg });
          throw err;
        }
        this.state.nodeStates.set(t.node.id, 'completed');
        this.state.nodeResults.set(t.node.id, result);
        this.mergeUsage(totalUsage, result.usage);
        stepsCompleted++;
        this.state.stepsCompleted = stepsCompleted;
        emit({ type: 'agent_result', agentId: t.node.id, agentName: t.node.name, result });
        waveResults = [{ id: t.node.id, result }];
      } else {
        // 多分支：并行执行（fail-fast，受 concurrency 限制）
        waveResults = await this.executeWave(tasks, ctx, emit, totalUsage);
        stepsCompleted += waveResults.length;
        this.state.stepsCompleted = stepsCompleted;
      }

      lastResult = waveResults[waveResults.length - 1].result;
      lastAgentId = waveResults[waveResults.length - 1].id;
      frontier = waveResults;

      // 检查终止条件
      if (this.finishCondition?.(ctx)) {
        return this.buildResult(lastResult!, lastAgentId, ctx, totalUsage, stepsCompleted, 'finish_condition');
      }
    }

    return this.buildResult(lastResult!, lastAgentId, ctx, totalUsage, stepsCompleted, stopReason);
  }

  /** 并行执行一个 wave 的节点（fail-fast + concurrency 限流） */
  private async executeWave(
    tasks: Array<{ node: AgentNode; input: string | Request; fromId: string }>,
    ctx: SharedContext,
    emit: (event: MultiAgentEvent) => void,
    totalUsage: Record<string, number>,
  ): Promise<Array<{ id: string; result: Result }>> {
    const results: Array<{ id: string; result: Result }> = [];
    emit({ type: 'parallel_start', agentIds: tasks.map(t => t.node.id) });

    const runOne = async (t: { node: AgentNode; input: string | Request; fromId: string }): Promise<void> => {
      this.state.currentAgentId = t.node.id;
      this.state.nodeStates.set(t.node.id, 'running');
      emit({ type: 'edge_traversed', from: t.fromId, to: t.node.id });
      emit({ type: 'agent_start', agentId: t.node.id, agentName: t.node.name, input: toInputText(t.input) });
      try {
        const result = await executeNode(t.node, t.input, ctx);
        this.state.nodeStates.set(t.node.id, 'completed');
        this.state.nodeResults.set(t.node.id, result);
        this.mergeUsage(totalUsage, result.usage);
        results.push({ id: t.node.id, result });
        emit({ type: 'agent_result', agentId: t.node.id, agentName: t.node.name, result });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        this.state.nodeStates.set(t.node.id, 'failed');
        emit({ type: 'agent_error', agentId: t.node.id, agentName: t.node.name, error: errorMsg });
        throw err;
      }
    };

    if (this.concurrency >= tasks.length) {
      await Promise.all(tasks.map(t => runOne(t)));
    } else {
      // 限流并发池
      let index = 0;
      const executing = new Set<Promise<void>>();
      const enqueue = (): Promise<void> | null => {
        if (index >= tasks.length) return null;
        const i = index++;
        const p: Promise<void> = runOne(tasks[i]).finally(() => { executing.delete(p); });
        executing.add(p);
        p.catch(() => {}); // fail-fast 提前退出后防 unhandledRejection
        return p;
      };
      for (let i = 0; i < this.concurrency && index < tasks.length; i++) {
        enqueue();
      }
      while (executing.size > 0) {
        await Promise.race(executing);
        enqueue();
      }
    }

    emit({ type: 'parallel_done', results: new Map(results.map(r => [r.id, r.result])) });
    return results;
  }

  private buildResult(
    lastResult: Result,
    lastAgentId: string,
    ctx: SharedContext,
    totalUsage: Record<string, number>,
    stepsCompleted: number,
    stopReason: string,
  ): MultiAgentResult {
    this.state.finished = true;
    return {
      content: lastResult.content,
      lastAgentId,
      agentResults: new Map(this.state.nodeResults),
      totalUsage,
      stepsCompleted,
      stopReason,
      context: ctx,
      success: lastResult.success,
      error: lastResult.error,
    };
  }

  private mergeUsage(total: Record<string, number>, usage: Record<string, number>): void {
    for (const [key, value] of Object.entries(usage)) {
      total[key] = (total[key] ?? 0) + value;
    }
  }
}
