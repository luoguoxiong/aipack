/**
 * patterns/supervisor.ts - Supervisor 层级委派模式
 *
 * Supervisor Agent 拆解任务分配给 Worker Agents，
 * 根据调度策略执行（parallel / sequential / auto）。
 */

import type { AgentNode, AgentGraph, SupervisorOpts, EventListener, MultiAgentResult, MultiAgentEvent } from '../core/types';
import { SupervisorExecutor } from '../core/supervisor-executor';
import { SimpleEventBus } from '../core/context';
import type { Request } from '@aipack-ai/agent';

// ─── SupervisorGraphImpl ─────────────────────────────────────────

class SupervisorGraphImpl implements AgentGraph {
  private executor: SupervisorExecutor;
  /** on() 注册的监听器，按 MultiAgentEvent.type 分发 */
  private bus = new SimpleEventBus();

  constructor(supervisor: AgentNode, workers: AgentNode[], opts?: SupervisorOpts) {
    this.executor = new SupervisorExecutor(supervisor, workers, opts);
  }

  // AgentGraph 接口方法（Supervisor 不使用 addNode/addEdge/setEntry/setFinish）
  addNode(): this {
    throw new Error('Supervisor 模式不支持手动 addNode，请在 createSupervisor() 中配置');
  }
  addEdge(): this {
    throw new Error('Supervisor 模式不支持手动 addEdge，调度由 Supervisor 自动管理');
  }
  setEntry(): this {
    throw new Error('Supervisor 模式不支持 setEntry，入口固定为 Supervisor');
  }
  setFinish(): this {
    throw new Error('Supervisor 模式不支持 setFinish，终止由 Supervisor 判定');
  }

  async run(input: string | Request): Promise<MultiAgentResult> {
    this.executor.setEventSink(event => this.bus.emit(event.type, event));
    return this.executor.run(input);
  }

  async *stream(input: string | Request): AsyncGenerator<MultiAgentEvent> {
    this.executor.setEventSink(event => this.bus.emit(event.type, event));
    yield* this.executor.stream(input);
  }

  getState() {
    return this.executor.getState();
  }

  abort(): void {
    this.executor.abort();
  }

  on(event: string, listener: EventListener): this {
    this.bus.on(event, listener);
    return this;
  }
}

// ─── createSupervisor 工厂函数 ───────────────────────────────────

/**
 * 创建 Supervisor 层级委派模式
 *
 * @param supervisor - Supervisor Agent（负责拆解任务并分配）
 * @param workers - Worker Agent 列表（负责执行具体任务）
 * @param opts - Supervisor 配置选项
 * @returns AgentGraph 实例
 */
export function createSupervisor(
  supervisor: AgentNode,
  workers: AgentNode[],
  opts?: SupervisorOpts,
): AgentGraph {
  if (workers.length === 0) {
    throw new Error('Supervisor: 至少需要一个 Worker Agent');
  }

  return new SupervisorGraphImpl(supervisor, workers, opts);
}
