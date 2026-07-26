/**
 * Agent Context Runtime (ACR) v2.1
 * Agent 上下文运行时 - 上下文操作系统
 *
 * 管理完整的上下文生命周期：
 * 观察（Observe）→ 理解（Understand）→ 压缩（Compress）
 * → 记忆（Remember）→ 重建（Rebuild）→ 继续（Continue）
 *
 * 核心模块：
 * - runtime: 主运行时入口
 * - state: 状态管理（AgentState、消息适配器、状态提取器、快照构建器）
 * - compress: 压缩策略（L1-L5 五级压缩）
 * - monitor: 监控器（Token 监控、价值密度监控）
 * - tool: 工具处理（工具摘要器）
 * - memory: 记忆系统（会话记忆、工作区记忆、用户记忆）
 * - observer: 观察者（工作区观察）
 * - observability: 可观测性（指标收集）
 * - config: 配置（默认配置、预设配置文件）
 */

// 主运行时
export { AgentContextRuntime } from './runtime';
export type { AgentContextRuntimeOptions, ACREventListener } from './runtime';

// 类型定义
export type {
  AgentState,               // Agent 状态模型
  TaskPhase,                // 任务阶段
  HealthLevel,              // 健康级别
  CompressionLevel,         // 压缩级别
  CompressionResult,        // 压缩结果
  CompactOptions,           // 压缩选项
  ACRConfig,                // ACR 配置
  ACRProfile,               // 配置文件类型
  WorkspaceObserverState,   // 工作区观察者状态
  ToolDigest,               // 工具摘要
  HealthSnapshot,           // 健康快照
  MessageTag,               // 消息标签
  MemoryLayer,              // 记忆层级
} from './types';

// 重新导出有用的工具函数
export { formatStateSnapshot, createInitialState } from './state/agent-state';
export { DEFAULT_CONFIG, CODING_PROFILE, RESEARCH_PROFILE, ASSISTANT_PROFILE, getProfileConfig, mergeConfig } from './config/defaults';
export {
  getMessageContent,          // 获取消息内容
  setMessageContent,          // 设置消息内容
  createStateSnapshotMessage, // 创建状态快照消息
  createCompactionMessage,    // 创建压缩摘要消息
  createToolDigestMessage,    // 创建工具摘要消息
  isCustomMessage,            // 判断是否是自定义消息
  isStateSnapshot,            // 判断是否是状态快照
  isToolDigest,               // 判断是否是工具摘要
  isCompactionSummary,        // 判断是否是压缩摘要
  estimateMessageTokens,      // 估算消息 token 数
  findStateSnapshotIndex,     // 查找状态快照位置
  removeStateSnapshots,       // 移除状态快照
  removeToolDigests,          // 移除工具摘要
} from './state/message-adapter';
