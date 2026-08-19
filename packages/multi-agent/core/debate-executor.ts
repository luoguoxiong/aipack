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
import { createSharedContext } from './context';
import { executeNode } from './executor';

// ─── DebateExecutor ──────────────────────────────────────────────

export class DebateExecutor {
  private proposerNode: AgentNode;
  private reviewerNode: AgentNode;
  private maxRounds: number;
  private convergeWhen: (reviewerResult: Result) => boolean;
  private feedbackTransform: (reviewerResult: Result, proposerResult: Result) => string;
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
    return { ...this.state };
  }

  /** 执行 Debate */
  async run(input: string | Request): Promise<MultiAgentResult> {
    const ctx = createSharedContext({
      meta: { traceId: `debate-${Date.now()}`, startTime: Date.now() },
    });

    try {
      return await this.executeDebate(input, ctx, () => {});
    } catch (err) {
      return this.buildErrorResult(ctx, err);
    }
  }

  /** 流式执行 Debate */
  async *stream(input: string | Request): AsyncGenerator<MultiAgentEvent> {
    const ctx = createSharedContext({
      meta: { traceId: `debate-${Date.now()}`, startTime: Date.now() },
    });

    const eventQueue: MultiAgentEvent[] = [];
    let resolveEvent: (() => void) | null = null;
    let done = false;

    const emit = (event: MultiAgentEvent) => {
      eventQueue.push(event);
      resolveEvent?.();
    };

    const graphPromise = this.executeDebate(input, ctx, emit).then(
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
      emit({ type: 'round_start', round });

      // ── 执行 Proposer ──────────────────────────────────────
      this.state.currentAgentId = this.proposerNode.id;
      this.state.nodeStates.set(this.proposerNode.id, 'running');
      emit({ type: 'agent_start', agentId: this.proposerNode.id, agentName: this.proposerNode.name });

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
      emit({ type: 'agent_start', agentId: this.reviewerNode.id, agentName: this.reviewerNode.name });

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
    return {
      content: '',
      lastAgentId: this.proposerNode.id,
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
