/**
 * core/types.ts - 多Agent编排核心类型
 *
 * 定义 AgentNode, AgentEdge, SharedContext, AgentGraph 等核心抽象。
 * P0 范围：AgentGraph + Pipeline + Router。
 */

import type { Runtime, RuntimeOptions } from '@aipack-ai/agent';
import type { Tool } from '@aipack-ai/agent';
import type { Result } from '@aipack-ai/agent';
import type { Request } from '@aipack-ai/agent';

// ─── SharedContext: Agent间共享上下文 ─────────────────────────────

/** 事件总线监听器 */
export type EventListener<T = unknown> = (event: T) => void;

/** 事件总线：Agent间异步通知 */
export interface EventBus {
  /** 订阅事件 */
  on(event: string, listener: EventListener): this;
  /** 取消订阅 */
  off(event: string, listener: EventListener): this;
  /** 发射事件 */
  emit(event: string, data?: unknown): this;
}

/** 工具注册表：跨Agent工具共享 */
export interface ToolRegistry {
  /** 注册工具 */
  register(tool: Tool): this;
  /** 批量注册 */
  registerAll(tools: Tool[]): this;
  /** 获取工具 */
  get(name: string): Tool | undefined;
  /** 获取所有工具 */
  getAll(): Tool[];
  /** 检查工具是否存在 */
  has(name: string): boolean;
}

/** Agent间共享上下文 */
export interface SharedContext {
  /** 黑板：键值共享存储 */
  blackboard: Map<string, unknown>;
  /** 事件总线：Agent间异步通知 */
  bus: EventBus;
  /** 全局工具注册表 */
  toolRegistry: ToolRegistry;
  /** 运行元数据（traceId, startTime, etc.） */
  meta: Record<string, unknown>;
}

// ─── AgentNode: 图中的Agent节点 ──────────────────────────────────

/** Agent节点：图中的执行单元 */
export interface AgentNode {
  /** 唯一标识 */
  id: string;
  /** 节点显示名 */
  name: string;
  /** Agent描述（注入到systemPrompt） */
  description: string;
  /** Runtime实例（或创建选项） */
  runtime: Runtime | RuntimeOptions;
  /** 该Agent专有的工具（除了共享工具外） */
  tools?: Tool[];
  /** 输入转换：从SharedContext提取该Agent需要的上下文 */
  inputMapping?: (ctx: SharedContext) => string | Request;
  /** 输出转换：将Agent结果写入SharedContext */
  outputMapping?: (result: Result, ctx: SharedContext) => void;
}

// ─── AgentEdge: Agent间流转边 ───────────────────────────────────

/** Agent间流转边 */
export interface AgentEdge {
  /** 源Agent ID */
  from: string;
  /** 目标Agent ID */
  to: string;
  /** 条件：决定是否走这条边（默认always true） */
  condition?: (result: Result, ctx: SharedContext) => boolean;
  /** 边上的转换：修改传递给下一个Agent的输入 */
  transform?: (result: Result, ctx: SharedContext) => string | Request;
}

// ─── 图执行状态 ──────────────────────────────────────────────────

/** 单个Agent的执行状态 */
export type NodeExecutionState = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

/** 图执行状态快照 */
export interface GraphExecutionState {
  /** 当前执行到哪个节点 */
  currentAgentId?: string;
  /** 各节点执行状态 */
  nodeStates: Map<string, NodeExecutionState>;
  /** 各节点的执行结果 */
  nodeResults: Map<string, Result>;
  /** 已完成的步数 */
  stepsCompleted: number;
  /** 总步数（预估） */
  totalSteps?: number;
  /** 是否已完成 */
  finished: boolean;
  /** 是否出错 */
  error?: string;
}

// ─── 多Agent运行结果 ─────────────────────────────────────────────

/** 多Agent运行结果 */
export interface MultiAgentResult {
  /** 最终输出文本 */
  content: string;
  /** 最后一个执行的Agent ID */
  lastAgentId: string;
  /** 各Agent执行结果 */
  agentResults: Map<string, Result>;
  /** 累计token用量 */
  totalUsage: Record<string, number>;
  /** 执行步数 */
  stepsCompleted: number;
  /** 停止原因 */
  stopReason: string;
  /** 共享上下文快照 */
  context: SharedContext;
  /** 是否成功 */
  success: boolean;
  /** 错误信息 */
  error?: string;
}

// ─── 多Agent流式事件 ─────────────────────────────────────────────

/** 多Agent流式事件类型 */
export type MultiAgentEvent =
  | { type: 'agent_start'; agentId: string; agentName: string }
  | { type: 'agent_result'; agentId: string; agentName: string; result: Result }
  | { type: 'agent_error'; agentId: string; agentName: string; error: string }
  | { type: 'edge_traversed'; from: string; to: string }
  | { type: 'parallel_start'; agentIds: string[] }
  | { type: 'parallel_done'; results: Map<string, Result> }
  | { type: 'round_start'; round: number }
  | { type: 'converged'; round: number; reason: string }
  | { type: 'graph_done'; result: MultiAgentResult }
  | { type: 'graph_error'; error: string };

// ─── AgentGraph: 编排核心接口 ────────────────────────────────────

/** AgentGraph: 编排核心 */
export interface AgentGraph {
  /** 添加Agent节点 */
  addNode(node: AgentNode): this;
  /** 添加流转边 */
  addEdge(edge: AgentEdge): this;
  /** 设置入口Agent */
  setEntry(agentId: string): this;
  /** 设置终止条件 */
  setFinish(condition: (ctx: SharedContext) => boolean): this;
  /** 执行图 */
  run(input: string | Request): Promise<MultiAgentResult>;
  /** 流式执行 */
  stream(input: string | Request): AsyncGenerator<MultiAgentEvent>;
  /** 获取执行状态 */
  getState(): GraphExecutionState;
  /** 中止执行 */
  abort(): void;
  /** 事件监听 */
  on(event: string, listener: EventListener): this;
}

// ─── Pipeline 选项 ───────────────────────────────────────────────

/** Pipeline 配置选项 */
export interface PipelineOpts {
  /** 是否传递前一个Agent的完整Result到下一个Agent（默认只传content文本） */
  passFullResult?: boolean;
  /** 节点间输出转换（全局，优先级低于AgentNode.outputMapping） */
  outputTransform?: (result: Result, ctx: SharedContext) => string;
}

// ─── Router 选项 ─────────────────────────────────────────────────

/** Router 配置选项 */
export interface RouterOpts {
  /** 从路由Agent输出中解析目标Agent ID */
  resolve: (routerResult: Result) => string;
  /** 未匹配到目标时的默认路由Agent ID */
  defaultTarget?: string;
  /** 是否将原始输入传递给目标Agent（默认true），否则传递路由Agent的输出 */
  passOriginalInput?: boolean;
}

// ─── Supervisor 选项 ─────────────────────────────────────────────

/** 执行调度策略 */
export type ScheduleMode = 'auto' | 'sequential' | 'parallel';

/** Supervisor 配置选项 */
export interface SupervisorOpts {
  /**
   * 执行调度策略：
   * - 'parallel': 所有工作者并行执行
   * - 'sequential': 工作者按顺序依次执行
   * - 'auto': 根据工作者 inputMapping 的 blackboard 依赖自动推导执行顺序
   *   （仅读 supervisor 输出的并行，依赖其他工作者结果的串行在后）
   * 默认 'parallel'
   */
  schedule?: ScheduleMode;
  /**
   * 并行执行时的最大并发数（默认 Infinity，不限制）
   * 用于避免 API 限流
   */
  concurrency?: number;
  /** Supervisor 输出后，是否将原始用户输入也传递给工作者（通过 blackboard.__original_input__）
   * 默认 true
   */
  passOriginalInput?: boolean;
}

// ─── Debate 选项 ─────────────────────────────────────────────────

/** Debate 配置选项 */
export interface DebateOpts {
  /** 最大辩论轮数（默认 3） */
  maxRounds?: number;
  /** 收敛条件：当 reviewer 的输出满足此条件时提前结束 */
  convergeWhen: (reviewerResult: Result) => boolean;
  /** 将 reviewer 的反馈如何转换为 proposer 的输入（默认：将 reviewer 输出拼接为修复指令） */
  feedbackTransform?: (reviewerResult: Result, proposerResult: Result) => string;
}

// ─── MapReduce 选项 ──────────────────────────────────────────────

/** MapReduce 配置选项 */
export interface MapReduceOpts {
  /** 将输入拆分为多个子任务的函数 */
  split: (input: string) => string[];
  /** 并行执行时的最大并发数（默认 Infinity） */
  concurrency?: number;
  /** Reducer 的输入格式化（默认将所有 mapper 结果用分隔符连接） */
  reduceInputFormat?: (mapperResults: Map<number, Result>) => string;
}

// ─── MCPBridge 选项 ─────────────────────────────────────────────

/** MCPBridge 配置选项 */
export interface MCPBridgeOpts {
  /** MCP Server 名称（默认 'aipack-multi-agent'） */
  serverName?: string;
  /** MCP Server 版本（默认 '1.0.0'） */
  serverVersion?: string;
  /** 将 AgentGraph 注册为 MCP 工具时的工具名前缀 */
  toolPrefix?: string;
}

// ─── GraphTrace: 执行追踪 ───────────────────────────────────────

/** 单步追踪记录 */
export interface TraceStep {
  /** 步骤序号（从 1 开始） */
  step: number;
  /** 执行的 Agent ID */
  agentId: string;
  /** Agent 名称 */
  agentName: string;
  /** 执行开始时间（ms 时间戳） */
  startTime: number;
  /** 执行耗时（ms） */
  duration: number;
  /** 输入摘要 */
  input: string;
  /** 输出摘要 */
  output: string;
  /** 执行状态 */
  state: NodeExecutionState;
  /** 错误信息（仅失败时有） */
  error?: string;
}

/** 图执行追踪记录 */
export interface GraphTrace {
  /** 追踪 ID */
  traceId: string;
  /** 图开始时间（ms 时间戳） */
  startTime: number;
  /** 图总耗时（ms） */
  duration: number;
  /** 各步骤记录 */
  steps: TraceStep[];
  /** 最终结果摘要 */
  result: {
    success: boolean;
    content: string;
    stopReason: string;
    stepsCompleted: number;
  };
}
