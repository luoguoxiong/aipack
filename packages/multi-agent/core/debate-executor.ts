/**
 * core/debate-executor.ts - Debate 对抗评审执行器
 *
 * 实现 proposer ↔ reviewer 循环辩论模式：
 * 1. Proposer 生成初始结果
 * 2. Reviewer 审查并给出反馈
 * 3. 如果未收敛，将反馈转为 proposer 输入，回到步骤 1
 * 4. 收敛或达最大轮次时结束
 */

import type { Result, Request } from '@aipack-ai/agent';
import type {
  AgentNode,
  SharedContext,
  MultiAgentResult,
  MultiAgentEvent,
  DebateOpts,
  GraphExecutionState,
} from './types';
import { createSharedContext, storeOriginalInput } from './context';
import { executeNode, GraphAbortedError, toInputText } from './executor';
import { createEventStream } from './event-stream';

// ─── DebateExecutor ──────────────────────────────────────────────

export class DebateExecutor {
  private proposerNode: AgentNode;
  private reviewerNode: AgentNode;
  private maxRounds: number;
  private convergeWhen: (reviewerResult: Result) => boolean;
  private feedbackTransform: (reviewerResult: Result, proposerResult: Result) => string;
  private abortController = new AbortController();
  /** 外部事件监听（on() API 的底层接线） */
  private eventSink?: (event: MultiAgentEvent) => void;
  private state: GraphExecutionState = {
    nodeStates: new Map(),
    nodeResults: new Map(),
    stepsCompleted: 0,
    finished: false,
  };

  constructor(proposer: AgentNode, reviewer: AgentNode, opts: DebateOpts) {
    this.proposerNode = proposer;
    this.reviewerNode = reviewer;
    this.maxRounds = opts.maxRounds ?? 3;
    this.convergeWhen = opts.convergeWhen;
    this.feedbackTransform = opts.feedbackTransform ?? ((reviewerResult, proposerResult) => {
      return `以下是审查意见:\n${reviewerResult.content}\n\n请修复以上问题并重新提交。原始输出:\n${proposerResult.content}`;
    });

    this.state.nodeStates.set(proposer.id, 'pending');
    this.state.nodeStates.set(reviewer.id, 'pending');
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
    this.state.nodeStates.set(this.proposerNode.id, 'pending');
    this.state.nodeStates.set(this.reviewerNode.id, 'pending');
  }

  private throwIfAborted(): void {
    if (this.abortController.signal.aborted) {
      throw new GraphAbortedError();
    }
  }

  /** 执行 Debate */
  async run(input: string | Request): Promise<MultiAgentResult> {
    this.resetAbortController();
    const ctx = createSharedContext({
      meta: { traceId: `debate-${Date.now()}`, startTime: Date.now() },
    });
    storeOriginalInput(ctx, input);

    const emit = this.eventSink ?? (() => {});

    try {
      const result = await this.executeDebate(input, ctx, emit);
      emit({ type: 'graph_done', result });
      return result;
    } catch (err) {
      const result = this.buildErrorResult(ctx, err);
      emit({ type: 'graph_error', error: result.error ?? '' });
      return result;
    }
  }

  /** 流式执行 Debate */
  stream(input: string | Request): AsyncGenerator<MultiAgentEvent> {
    this.resetAbortController();
    const ctx = createSharedContext({
      meta: { traceId: `debate-${Date.now()}`, startTime: Date.now() },
    });
    storeOriginalInput(ctx, input);

    return createEventStream(
      emit => this.executeDebate(input, ctx, emit).then(
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
  private async executeDebate(
    input: string | Request,
    ctx: SharedContext,
    emit: (event: MultiAgentEvent) => void,
  ): Promise<MultiAgentResult> {
    let stepsCompleted = 0;
    const totalUsage: Record<string, number> = {};
    let lastProposerResult!: Result;
    let lastReviewerResult!: Result;
    let convergedRound = 0;
    let convergeReason = '';
    let currentInput: string | Request = input;

    for (let round = 1; round <= this.maxRounds; round++) {
      this.throwIfAborted();
      emit({ type: 'round_start', round });

      // ── 执行 Proposer ──────────────────────────────────────
      this.state.currentAgentId = this.proposerNode.id;
      this.state.nodeStates.set(this.proposerNode.id, 'running');
      emit({ type: 'agent_start', agentId: this.proposerNode.id, agentName: this.proposerNode.name, input: toInputText(currentInput) });

      try {
        lastProposerResult = await executeNode(this.proposerNode, currentInput, ctx);
        this.state.nodeStates.set(this.proposerNode.id, 'completed');
        this.state.nodeResults.set(`${this.proposerNode.id}_r${round}`, lastProposerResult);
        this.mergeUsage(totalUsage, lastProposerResult.usage);
        stepsCompleted++;
        this.state.stepsCompleted = stepsCompleted;
        emit({ type: 'agent_result', agentId: this.proposerNode.id, agentName: this.proposerNode.name, result: lastProposerResult });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        this.state.nodeStates.set(this.proposerNode.id, 'failed');
        emit({ type: 'agent_error', agentId: this.proposerNode.id, agentName: this.proposerNode.name, error: errorMsg });
        throw err;
      }

      // ── 执行 Reviewer ──────────────────────────────────────
      this.state.currentAgentId = this.reviewerNode.id;
      this.state.nodeStates.set(this.reviewerNode.id, 'running');
      emit({ type: 'agent_start', agentId: this.reviewerNode.id, agentName: this.reviewerNode.name, input: lastProposerResult.content });

      try {
        lastReviewerResult = await executeNode(this.reviewerNode, lastProposerResult.content, ctx);
        this.state.nodeStates.set(this.reviewerNode.id, 'completed');
        this.state.nodeResults.set(`${this.reviewerNode.id}_r${round}`, lastReviewerResult);
        this.mergeUsage(totalUsage, lastReviewerResult.usage);
        stepsCompleted++;
        this.state.stepsCompleted = stepsCompleted;
        emit({ type: 'agent_result', agentId: this.reviewerNode.id, agentName: this.reviewerNode.name, result: lastReviewerResult });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        this.state.nodeStates.set(this.reviewerNode.id, 'failed');
        emit({ type: 'agent_error', agentId: this.reviewerNode.id, agentName: this.reviewerNode.name, error: errorMsg });
        throw err;
      }

      // ── 检查收敛 ────────────────────────────────────────────
      if (this.convergeWhen(lastReviewerResult)) {
        convergedRound = round;
        convergeReason = `收敛于第 ${round} 轮：reviewer 输出满足收敛条件`;
        emit({ type: 'converged', round, reason: convergeReason });
        break;
      }

      // ── 准备下一轮输入 ──────────────────────────────────────
      currentInput = this.feedbackTransform(lastReviewerResult, lastProposerResult);
    }

    // 最终结果：收敛时取 proposer 最后一轮输出，未收敛时也取 proposer 输出
    const finalResult = lastProposerResult;
    const stopReason = convergedRound > 0
      ? `converged_at_round_${convergedRound}`
      : `max_rounds_reached`;

    this.state.finished = true;
    return {
      content: finalResult.content,
      lastAgentId: this.reviewerNode.id,
      agentResults: new Map(this.state.nodeResults),
      totalUsage,
      stepsCompleted,
      stopReason,
      context: ctx,
      success: true,
    };
  }

  private buildErrorResult(ctx: SharedContext, err: unknown): MultiAgentResult {
    this.state.finished = true;
    const aborted = err instanceof GraphAbortedError;
    const errorMsg = err instanceof Error ? err.message : String(err);
    this.state.error = errorMsg;
    const lastCompleted = [...this.state.nodeResults.values()].at(-1);
    return {
      content: aborted ? (lastCompleted?.content ?? '') : '',
      lastAgentId: this.proposerNode.id,
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
