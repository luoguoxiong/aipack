/**
 * core/index.ts - 核心层导出
 */

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
} from './types';

export { createSharedContext, SimpleEventBus, SimpleToolRegistry } from './context';
export { createAgentGraph } from './graph';
export { GraphExecutor, ensureRuntime, executeNode, findNextEdges, resolveInput } from './executor';
export { SupervisorExecutor } from './supervisor-executor';
export { DebateExecutor } from './debate-executor';
export { MapReduceExecutor } from './map-reduce-executor';
