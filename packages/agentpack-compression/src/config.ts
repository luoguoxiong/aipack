/**
 * 压缩配置 - 所有阈值支持环境变量覆盖
 *
 * 注意：所有 `targetRatio` 表示"压缩后目标 token 占 contextWindow 的比例"，
 * 当单次压缩未达到目标时，转换器会按级向上升级。
 * `forkModel` 为空表示复用主模型；`forkMaxTokens` 限制 fork 输出长度。
 */

import type { ResourceType } from 'agentpack';

// ─── 配置接口 ─────────────────────────────────────────────────────

export interface CompressionConfig {
  enabled: boolean;

  /** 估算器类型（当前仅支持 'char-heuristic'） */
  estimator: 'char-heuristic';
  /** 估算器缓存容量 */
  estimatorCacheCapacity: number;
  charsPerToken: { ascii: number; cjk: number };

  /** fork 调用超时（ms），0 表示不超时 */
  forkTimeoutMs: number;

  /** L1: 工具输出裁剪 */
  l1: {
    enabled: boolean;
    threshold: number;
    targetRatio: number;
    stripThinking: boolean;
    trimToolResults: boolean;
    toolResultMaxLines: number;
    toolResultHeadLines: number;
    toolResultTailLines: number;
    normalizeWhitespace: boolean;
  };

  /** L2: 旧消息摘要 */
  l2: {
    enabled: boolean;
    threshold: number;
    targetRatio: number;
    /** fork 用模型 id；为空则复用主模型 */
    forkModel?: string;
    /** fork 输出 max tokens 上限（覆盖 Model.maxTokens） */
    forkMaxTokens: number;
    minResourcesToCompress: number;
    protectedRecentCount: number;
    /** 单次 pipeline 内最大压缩深度（不跨 turn 累积） */
    maxCompressionDepth: number;
  };

  /** L3: 任务状态提取 */
  l3: {
    enabled: boolean;
    threshold: number;
    targetRatio: number;
    forkModel?: string;
    forkMaxTokens: number;
    protectedRecentCount: number;
  };

  /** L4: 会话检查点 */
  l4: {
    enabled: boolean;
    threshold: number;
    targetRatio: number;
    /** 检查点存储后端类型（仅用于遥测标注，实际后端由 sessionStorage 决定） */
    checkpointStorage: 'file' | 'memory' | 'custom';
    minWorkingSet: number;
    /** 持久化失败时是否中止压缩（推荐 true，避免信息丢失） */
    failOnPersistError: boolean;
  };

  /** L5: 新会话交接 */
  l5: {
    enabled: boolean;
    threshold: number;
    forkModel?: string;
    forkMaxTokens: number;
  };

  safety: {
    maxAttempts: number;
    cooldownTurns: number;
    forkTimeoutMs?: number;
  };

  telemetry: {
    enabled: boolean;
    logTokenDelta: boolean;
    logTriggerReason: boolean;
  };
}

// ─── 默认值 ───────────────────────────────────────────────────────

const DEFAULT_DROP_ORDER: ResourceType[] = [
  'tool_result',
  'tool_call',
  'user_message',
  'assistant_message',
];

// ─── 深度部分类型 ─────────────────────────────────────────────────

/** 深度部分类型，允许只覆盖嵌套对象的某些字段 */
export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

// ─── 环境变量加载 ─────────────────────────────────────────────────

export function loadCompressionConfig(
  overrides?: DeepPartial<CompressionConfig>,
): CompressionConfig {
  const env = process.env;

  const forkTimeoutMs = Number(env.AGENTPACK_COMPRESSION_FORK_TIMEOUT) || 30_000;

  const config: CompressionConfig = {
    enabled: env.AGENTPACK_COMPRESSION_ENABLED !== 'false',
    estimator: 'char-heuristic',
    estimatorCacheCapacity: Number(env.AGENTPACK_COMPRESSION_ESTIMATOR_CACHE) || 1000,
    charsPerToken: {
      ascii: Number(env.AGENTPACK_CHARS_PER_TOKEN_ASCII) || 4,
      cjk: Number(env.AGENTPACK_CHARS_PER_TOKEN_CJK) || 1.5,
    },

    forkTimeoutMs,

    l1: {
      enabled: env.AGENTPACK_L1_ENABLED !== 'false',
      threshold: Number(env.AGENTPACK_L1_THRESHOLD) || 0.60,
      targetRatio: Number(env.AGENTPACK_L1_TARGET) || 0.50,
      stripThinking: env.AGENTPACK_L1_STRIP_THINKING !== 'false',
      trimToolResults: env.AGENTPACK_L1_TRIM_TOOL_RESULTS !== 'false',
      toolResultMaxLines: Number(env.AGENTPACK_L1_TOOL_MAX_LINES) || 50,
      toolResultHeadLines: Number(env.AGENTPACK_L1_TOOL_HEAD_LINES) || 10,
      toolResultTailLines: Number(env.AGENTPACK_L1_TOOL_TAIL_LINES) || 10,
      normalizeWhitespace: env.AGENTPACK_L1_NORMALIZE_WS !== 'false',
    },

    l2: {
      enabled: env.AGENTPACK_L2_ENABLED !== 'false',
      threshold: Number(env.AGENTPACK_L2_THRESHOLD) || 0.75,
      targetRatio: Number(env.AGENTPACK_L2_TARGET) || 0.60,
      forkModel: env.AGENTPACK_L2_FORK_MODEL || undefined,
      forkMaxTokens: Number(env.AGENTPACK_L2_FORK_MAX_TOKENS) || 2048,
      minResourcesToCompress: Number(env.AGENTPACK_L2_MIN_RESOURCES) || 4,
      protectedRecentCount: Number(env.AGENTPACK_L2_PROTECTED_RECENT) || 6,
      maxCompressionDepth: Number(env.AGENTPACK_L2_MAX_DEPTH) || 3,
    },

    l3: {
      enabled: env.AGENTPACK_L3_ENABLED !== 'false',
      threshold: Number(env.AGENTPACK_L3_THRESHOLD) || 0.85,
      targetRatio: Number(env.AGENTPACK_L3_TARGET) || 0.40,
      forkModel: env.AGENTPACK_L3_FORK_MODEL || undefined,
      forkMaxTokens: Number(env.AGENTPACK_L3_FORK_MAX_TOKENS) || 1024,
      protectedRecentCount: Number(env.AGENTPACK_L3_PROTECTED_RECENT) || 4,
    },

    l4: {
      enabled: env.AGENTPACK_L4_ENABLED !== 'false',
      threshold: Number(env.AGENTPACK_L4_THRESHOLD) || 0.92,
      targetRatio: Number(env.AGENTPACK_L4_TARGET) || 0.25,
      checkpointStorage: (env.AGENTPACK_L4_STORAGE as CompressionConfig['l4']['checkpointStorage']) ?? 'file',
      minWorkingSet: Number(env.AGENTPACK_L4_MIN_WORKING_SET) || 2,
      failOnPersistError: env.AGENTPACK_L4_FAIL_ON_PERSIST_ERROR !== 'false',
    },

    l5: {
      enabled: env.AGENTPACK_L5_ENABLED !== 'false',
      threshold: Number(env.AGENTPACK_L5_THRESHOLD) || 0.95,
      forkModel: env.AGENTPACK_L5_FORK_MODEL || undefined,
      forkMaxTokens: Number(env.AGENTPACK_L5_FORK_MAX_TOKENS) || 2048,
    },

    safety: {
      maxAttempts: Number(env.AGENTPACK_COMPRESSION_MAX_ATTEMPTS) || 5,
      cooldownTurns: Number(env.AGENTPACK_COMPRESSION_COOLDOWN_TURNS) || 5,
      forkTimeoutMs,
    },

    telemetry: {
      enabled: env.AGENTPACK_COMPRESSION_TELEMETRY !== 'false',
      logTokenDelta: env.AGENTPACK_COMPRESSION_TELEMETRY_LOG_DELTA !== 'false',
      logTriggerReason: env.AGENTPACK_COMPRESSION_TELEMETRY_LOG_REASON !== 'false',
    },
  };

  if (overrides) {
    return deepMerge(config, overrides);
  }
  return config;
}

/** 导出默认丢弃顺序 */
export { DEFAULT_DROP_ORDER };

// ─── 工具函数 ─────────────────────────────────────────────────────

function deepMerge<T>(base: T, overrides: DeepPartial<T>): T {
  const result: any = Array.isArray(base) ? [...(base as any)] : { ...base };
  for (const key of Object.keys(overrides)) {
    const ov = (overrides as any)[key];
    const bv = (base as any)[key];
    if (ov && typeof ov === 'object' && !Array.isArray(ov) && bv && typeof bv === 'object') {
      result[key] = deepMerge(bv, ov);
    } else if (ov !== undefined) {
      result[key] = ov;
    }
  }
  return result;
}
