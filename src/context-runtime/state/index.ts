/**
 * 状态管理模块
 *
 * 包含：
 * - agent-state: AgentState 状态模型和操作
 * - state-extractor: 从消息和工具结果中提取状态
 * - snapshot-builder: 基于状态快照重建上下文窗口
 * - message-adapter: 消息内容处理和自定义消息创建
 */

export * from './agent-state';
export { StateExtractor } from './state-extractor';
export type { ToolResultInfo } from './state-extractor';
export { SnapshotBuilder } from './snapshot-builder';
