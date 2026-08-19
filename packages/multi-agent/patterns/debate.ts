/**
 * patterns/debate.ts - Debate 对抗评审模式
 *
 * Proposer 和 Reviewer 循环辩论，直到收敛或达最大轮次。
 */

import type { AgentNode, AgentGraph, DebateOpts, EventListener, MultiAgentResult, MultiAgentEvent } from '../core/types';
import { DebateExecutor } from '../core/debate-executor';
import type { Request } from '@aipack-ai/agent';

// ─── DebateGraphImpl ─────────────────────────────────────────────

class DebateGraphImpl implements AgentGraph {
  private executor: DebateExecutor;
  private eventListeners = new Map<string, Set<EventListener>>();

  constructor(proposer: AgentNode, reviewer: AgentNode, opts: DebateOpts) {
    this.executor = new DebateExecutor(proposer, reviewer, opts);
  }

  addNode(): this { throw new Error('Debate 模式不支持手动 addNode'); }
  addEdge(): this { throw new Error('Debate 模式不支持手动 addEdge'); }
  setEntry(): this { throw new Error('Debate 模式不支持 setEntry'); }
  setFinish(): this { throw new Error('Debate 模式不支持 setFinish'); }

  async run(input: string | Request): Promise<MultiAgentResult> {
    return this.executor.run(input);
  }

  async *stream(input: string | Request): AsyncGenerator<MultiAgentEvent> {
    yield* this.executor.stream(input);
  }

  getState() { return this.executor.getState(); }
  abort(): void {}

  on(event: string, listener: EventListener): this {
    let set = this.eventListeners.get(event);
    if (!set) { set = new Set(); this.eventListeners.set(event, set); }
    set.add(listener);
    return this;
  }
}

// ─── createDebate 工厂函数 ───────────────────────────────────────

/**
 * 创建 Debate 对抗评审模式
 *
 * @param proposer - 生成/修复方 Agent
 * @param reviewer - 审查方 Agent
 * @param opts - Debate 配置选项（必须提供 convergeWhen）
 * @returns AgentGraph 实例
 */
export function createDebate(
  proposer: AgentNode,
  reviewer: AgentNode,
  opts: DebateOpts,
): AgentGraph {
  return new DebateGraphImpl(proposer, reviewer, opts);
}
