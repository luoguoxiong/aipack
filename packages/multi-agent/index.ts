/**
 * @aipack-ai/multi-agent - 多Agent编排框架
 *
 * P0: AgentGraph 核心 + Pipeline + Router
 * P1: Supervisor + SharedContext/Blackboard
 * P2: Debate + MapReduce + 流式事件
 * P3: MCPBridge + 可视化调试
 */

// ─── 核心层 ──────────────────────────────────────────────────────
export type {
  AgentNode,
  AgentEdge,
  SharedContext,
  EventBus,
  ToolRegistry,
  EventListener,
  AgentGraph,
  MultiAgentResult,
  MultiAgentEvent,
  NodeExecutionState,
  GraphExecutionState,
  PipelineOpts,
  RouterOpts,
  SupervisorOpts,
  ScheduleMode,
  DebateOpts,
  MapReduceOpts,
  MCPBridgeOpts,
  TraceStep,
  GraphTrace,
} from './core/types';

export {
  createSharedContext,
  SimpleEventBus,
  SimpleToolRegistry,
} from './core/context';

export { createAgentGraph } from './core/graph';

// ─── 编排模式 ────────────────────────────────────────────────────
export { createPipeline } from './patterns/pipeline';
export { createRouter } from './patterns/router';
export { createSupervisor } from './patterns/supervisor';
export { createDebate } from './patterns/debate';
export { createMapReduce } from './patterns/map-reduce';

// ─── 扩展层 ──────────────────────────────────────────────────────
export { MCPBridge, createMCPBridge } from './extensions/mcp-bridge';
export type { MCPToolDefinition, MCPToolParameter, MCPToolCallRequest, MCPToolCallResult } from './extensions/mcp-bridge';

export { GraphDebugger, createDebugger } from './extensions/debug';
