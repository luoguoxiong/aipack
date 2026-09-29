/**
 * patterns/debate.ts - Debate 对抗评审模式
 *
 * Proposer 和 Reviewer 循环辩论，直到收敛或达最大轮次。
 */

import type { AgentNode, AgentGraph, DebateOpts, EventListener, MultiAgentResult, MultiAgentEvent } from '../core/types';
import { DebateExecutor } from '../core/debate-executor';
import { SimpleEventBus } from '../core/context';
import type { Request } from '@aipack-ai/agent';

// ─── DebateGraphImpl ─────────────────────────────────────────────

class DebateGraphImpl implements AgentGraph {
  private executor: DebateExecutor;
  /** on() 注册的监听器，按 MultiAgentEvent.type 分发 */
  private bus = new SimpleEventBus();

  constructor(proposer: AgentNode, reviewer: AgentNode, opts: DebateOpts) {
    this.executor = new DebateExecutor(proposer, reviewer, opts);
  }

  addNode(): this { throw new Error('Debate 模式不支持手动 addNode'); }
  addEdge(): this { throw new Error('Debate 模式不支持手动 addEdge'); }
  setEntry(): this { throw new Error('Debate 模式不支持 setEntry'); }
  setFinish(): this { throw new Error('Debate 模式不支持 setFinish'); }

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
