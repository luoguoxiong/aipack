/**
 * agentpack-compression -- agentpack 多级上下文压缩
 *
 * 五级渐进式降级：
 *   L1: ToolOutputTrim       工具输出裁剪（无损，缓存安全）
 *   L2: MessageSummarize     旧消息摘要（有损，Fork Agent）
 *   L3: TaskStateExtraction  任务状态提取（结构化降级）
 *   L4: SessionCheckpoint     会话检查点（持久化 + 激进缩减）
 *   L5: NewSessionHandoff    新会话交接（保底重置）
 *
 * 快速接入：
 *   import { createCompressionTransformer, loadCompressionConfig } from 'agentpack-compression';
 *   const transformer = createCompressionTransformer({
 *     config: loadCompressionConfig(),
 *     model, streamFn, contextWindow: model.contextWindow,
 *   });
 *   pipeline.use(transformer);
 */

// ─── 复合转换器 ───────────────────────────────────────────────────
export {
  ContextCompressionTransformer,
  createCompressionTransformer,
} from './src/compression-transformer';
export type { CompressionTransformerOptions } from './src/compression-transformer';

// ─── 配置 ─────────────────────────────────────────────────────────
export {
  loadCompressionConfig,
  DEFAULT_DROP_ORDER,
} from './src/config';
export type { CompressionConfig, DeepPartial } from './src/config';

// ─── Token 估算 ───────────────────────────────────────────────────
export {
  CharHeuristicEstimator,
  createTokenEstimator,
} from './src/token-estimator';
export type { TokenEstimator } from './src/token-estimator';

// ─── 安全机制 ─────────────────────────────────────────────────────
export {
  CompressionSafetyGuard,
  createSafetyState,
  buildToolPairMap,
  isToolPairComplete,
} from './src/safety';
export type {
  CompressionSafetyState,
  SafetyConfig,
} from './src/safety';

// ─── 遥测 ─────────────────────────────────────────────────────────
export {
  createTelemetry,
  ConsoleTelemetryReporter,
  CompressionTelemetryExtension,
} from './src/telemetry';
export type {
  CompressionTelemetry,
  TelemetryReporter,
} from './src/telemetry';

// ─── L1: 工具输出裁剪 ─────────────────────────────────────────────
export { ToolOutputTrim } from './src/l1-tool-output-trim';
export type { L1Config, CompressResult } from './src/l1-tool-output-trim';

// ─── L2: 旧消息摘要 ───────────────────────────────────────────────
export { MessageSummarize } from './src/l2-message-summarize';
export type { L2Config } from './src/l2-message-summarize';

// ─── L3: 任务状态提取 ─────────────────────────────────────────────
export { TaskStateExtraction, findTaskState } from './src/l3-task-state-extraction';
export type { L3Config, TaskState } from './src/l3-task-state-extraction';

// ─── L4: 会话检查点 ───────────────────────────────────────────────
export { SessionCheckpointLevel } from './src/l4-session-checkpoint';
export type { L4Config, SessionCheckpoint } from './src/l4-session-checkpoint';

// ─── L5: 新会话交接 ───────────────────────────────────────────────
export { NewSessionHandoff } from './src/l5-new-session-handoff';
export type { L5Config, SessionHandoff } from './src/l5-new-session-handoff';

// ─── 从 agentpack 再导出常用类型 ──────────────────────────────────
export type {
  ContextResource,
  ContextTransformer,
  TransformContext,
  Extension,
  Model,
  StreamFn,
  SessionStorage,
} from 'agentpack';
export { BaseTransformer } from 'agentpack';
