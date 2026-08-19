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
} from './types';
import { createSharedContext } from './context';

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

export async function executeNode(
  node: AgentNode,
  input: string | Request,
  ctx: SharedContext,
): Promise<Result> {
  const runtime = ensureRuntime(node);

  // 构建 Request
  let req: Request;
  if (typeof input === 'string') {
    req = createRequest(input, { sessionKey: `multi-agent:${node.id}` });
  } else {
    req = { ...input, sessionKey: input.sessionKey ?? `multi-agent:${node.id}` };
  }

  // 执行
  const result = await runtime.run(req);

  // 输出映射
  if (node.outputMapping) {
    node.outputMapping(result, ctx);
  }

  return result;
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
  private state: GraphExecutionState = {
    nodeStates: new Map(),
    nodeResults: new Map(),
    stepsCompleted: 0,
    finished: false,
  };

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

  getState(): GraphExecutionState {
    return { ...this.state };
  }

  abort(): void {
    this.abortController.abort();
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

    const ctx = createSharedContext({
      meta: { traceId: `ma-${Date.now()}`, startTime: Date.now() },
    });
    const events: MultiAgentEvent[] = [];

    try {
      const result = await this.executeGraph(input, ctx, event => events.push(event));
      return result;
    } catch (err) {
      return {
        content: '',
        lastAgentId: this.state.currentAgentId ?? '',
        agentResults: this.state.nodeResults,
        totalUsage: {},
        stepsCompleted: this.state.stepsCompleted,
        stopReason: 'error',
        context: ctx,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** 流式执行图 */
  async *stream(input: string | Request): AsyncGenerator<MultiAgentEvent> {
    // 前置校验
    if (!this.entryId) {
      throw new Error('AgentGraph: 入口节点未设置，请调用 setEntry()');
    }
    if (!this.nodes.has(this.entryId)) {
      throw new Error(`AgentGraph: 入口节点 "${this.entryId}" 不存在`);
    }

    const ctx = createSharedContext({
      meta: { traceId: `ma-${Date.now()}`, startTime: Date.now() },
    });

    const eventQueue: MultiAgentEvent[] = [];
    let resolveEvent: (() => void) | null = null;
    let done = false;

    const emit = (event: MultiAgentEvent) => {
      eventQueue.push(event);
      resolveEvent?.();
    };

    const graphPromise = this.executeGraph(input, ctx, emit).then(
      (result) => {
        emit({ type: 'graph_done', result });
      },
      (err) => {
        emit({ type: 'graph_error', error: err instanceof Error ? err.message : String(err) });
      },
    ).finally(() => {
      done = true;
      resolveEvent?.();
    });

    // 产出事件
    while (!done || eventQueue.length > 0) {
      if (eventQueue.length > 0) {
        yield eventQueue.shift()!;
      } else {
        await new Promise<void>(resolve => {
          resolveEvent = resolve;
        });
      }
    }

    await graphPromise;
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
    emit({ type: 'agent_start', agentId: currentId, agentName: entryNode.name });

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

    // 沿边遍历
    const visited = new Set<string>();
    // 允许环形（如review→coder），用计数防止无限循环
    const visitCount = new Map<string, number>();
    const MAX_VISITS_PER_NODE = 10;

    while (lastResult) {
      const nextEdges = findNextEdges(currentId, this.edges, lastResult, ctx);

      if (nextEdges.length === 0) {
        // 无出边，图执行完毕
        break;
      }

      // 取第一条匹配边（P0 不支持并行分支，按顺序取第一条）
      const edge = nextEdges[0];
      const nextNode = this.nodes.get(edge.to);

      if (!nextNode) {
        throw new Error(`AgentGraph: 目标节点 "${edge.to}" 不存在`);
      }

      // 防止无限循环
      const count = (visitCount.get(edge.to) ?? 0) + 1;
      if (count > MAX_VISITS_PER_NODE) {
        break;
      }
      visitCount.set(edge.to, count);

      // 解析输入
      currentInput = resolveInput(edge, lastResult, ctx, nextNode, input);

      // 执行下一节点
      currentId = edge.to;
      this.state.currentAgentId = currentId;
      this.state.nodeStates.set(currentId, 'running');
      emit({ type: 'edge_traversed', from: edge.from, to: edge.to });
      emit({ type: 'agent_start', agentId: currentId, agentName: nextNode.name });

      try {
        lastResult = await executeNode(nextNode, currentInput, ctx);
        this.state.nodeStates.set(currentId, 'completed');
        this.state.nodeResults.set(currentId, lastResult);
        this.mergeUsage(totalUsage, lastResult.usage);
        stepsCompleted++;
        this.state.stepsCompleted = stepsCompleted;
        emit({ type: 'agent_result', agentId: currentId, agentName: nextNode.name, result: lastResult });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        this.state.nodeStates.set(currentId, 'failed');
        emit({ type: 'agent_error', agentId: currentId, agentName: nextNode.name, error: errorMsg });
        throw err;
      }

      lastAgentId = currentId;

      // 检查终止条件
      if (this.finishCondition?.(ctx)) {
        return this.buildResult(lastResult, lastAgentId, ctx, totalUsage, stepsCompleted, 'finish_condition');
      }
    }

    return this.buildResult(lastResult!, lastAgentId, ctx, totalUsage, stepsCompleted, 'completed');
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
