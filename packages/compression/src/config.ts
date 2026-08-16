/**
 * 压缩配置 - 所有阈值支持环境变量覆盖
 *
 * 注意：所有 `targetRatio` 表示"压缩后目标 token 占 contextWindow 的比例"，
 * 当单次压缩未达到目标时，转换器会按级向上升级。
 * `forkModel` 为空表示复用主模型；`forkMaxTokens` 限制 fork 输出长度。
 */

import type { ResourceType } from '@aipack-ai/agent';
import type { RetryConfig } from './retry';

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
    /** P0#4: fork 调用重试配置 */
    retry: RetryConfig;
    /** P1#6: 同 session 是否强制串行化（默认 true） */
    serializePerSession: boolean;
  };

  /** P2#14: dryRun 模式：只算 token + 生成 telemetry，不修改 resources */
  dryRun: boolean;

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

  const forkTimeoutMs = Number(env.AIPACK_COMPRESSION_FORK_TIMEOUT) || 30_000;

  const config: CompressionConfig = {
    enabled: env.AIPACK_COMPRESSION_ENABLED !== 'false',
    estimator: 'char-heuristic',
    estimatorCacheCapacity: Number(env.AIPACK_COMPRESSION_ESTIMATOR_CACHE) || 1000,
    charsPerToken: {
      ascii: Number(env.AIPACK_CHARS_PER_TOKEN_ASCII) || 4,
      cjk: Number(env.AIPACK_CHARS_PER_TOKEN_CJK) || 1.5,
    },

    forkTimeoutMs,

    l1: {
      enabled: env.AIPACK_L1_ENABLED !== 'false',
      threshold: Number(env.AIPACK_L1_THRESHOLD) || 0.60,
      targetRatio: Number(env.AIPACK_L1_TARGET) || 0.50,
      stripThinking: env.AIPACK_L1_STRIP_THINKING !== 'false',
      trimToolResults: env.AIPACK_L1_TRIM_TOOL_RESULTS !== 'false',
      toolResultMaxLines: Number(env.AIPACK_L1_TOOL_MAX_LINES) || 50,
      toolResultHeadLines: Number(env.AIPACK_L1_TOOL_HEAD_LINES) || 10,
      toolResultTailLines: Number(env.AIPACK_L1_TOOL_TAIL_LINES) || 10,
      normalizeWhitespace: env.AIPACK_L1_NORMALIZE_WS !== 'false',
    },

    l2: {
      enabled: env.AIPACK_L2_ENABLED !== 'false',
      threshold: Number(env.AIPACK_L2_THRESHOLD) || 0.75,
      targetRatio: Number(env.AIPACK_L2_TARGET) || 0.60,
      forkModel: env.AIPACK_L2_FORK_MODEL || undefined,
      forkMaxTokens: Number(env.AIPACK_L2_FORK_MAX_TOKENS) || 2048,
      minResourcesToCompress: Number(env.AIPACK_L2_MIN_RESOURCES) || 4,
      protectedRecentCount: Number(env.AIPACK_L2_PROTECTED_RECENT) || 6,
      maxCompressionDepth: Number(env.AIPACK_L2_MAX_DEPTH) || 3,
    },

    l3: {
      enabled: env.AIPACK_L3_ENABLED !== 'false',
      threshold: Number(env.AIPACK_L3_THRESHOLD) || 0.85,
      targetRatio: Number(env.AIPACK_L3_TARGET) || 0.40,
      forkModel: env.AIPACK_L3_FORK_MODEL || undefined,
      forkMaxTokens: Number(env.AIPACK_L3_FORK_MAX_TOKENS) || 1024,
      protectedRecentCount: Number(env.AIPACK_L3_PROTECTED_RECENT) || 4,
    },

    l4: {
      enabled: env.AIPACK_L4_ENABLED !== 'false',
      threshold: Number(env.AIPACK_L4_THRESHOLD) || 0.92,
      targetRatio: Number(env.AIPACK_L4_TARGET) || 0.25,
      checkpointStorage: (env.AIPACK_L4_STORAGE as CompressionConfig['l4']['checkpointStorage']) ?? 'file',
      minWorkingSet: Number(env.AIPACK_L4_MIN_WORKING_SET) || 2,
      failOnPersistError: env.AIPACK_L4_FAIL_ON_PERSIST_ERROR !== 'false',
    },

    l5: {
      enabled: env.AIPACK_L5_ENABLED !== 'false',
      threshold: Number(env.AIPACK_L5_THRESHOLD) || 0.95,
      forkModel: env.AIPACK_L5_FORK_MODEL || undefined,
      forkMaxTokens: Number(env.AIPACK_L5_FORK_MAX_TOKENS) || 2048,
    },

    safety: {
      maxAttempts: Number(env.AIPACK_COMPRESSION_MAX_ATTEMPTS) || 5,
      cooldownTurns: Number(env.AIPACK_COMPRESSION_COOLDOWN_TURNS) || 5,
      forkTimeoutMs,
      retry: {
        retries: Number(env.AIPACK_FORK_RETRY_COUNT) || 2,
        baseMs: Number(env.AIPACK_FORK_RETRY_BASE_MS) || 500,
        maxMs: Number(env.AIPACK_FORK_RETRY_MAX_MS) || 4000,
      },
      serializePerSession: env.AIPACK_COMPRESSION_SERIALIZE !== 'false',
    },

    dryRun: env.AIPACK_COMPRESSION_DRY_RUN === 'true',

    telemetry: {
      enabled: env.AIPACK_COMPRESSION_TELEMETRY !== 'false',
      logTokenDelta: env.AIPACK_COMPRESSION_TELEMETRY_LOG_DELTA !== 'false',
      logTriggerReason: env.AIPACK_COMPRESSION_TELEMETRY_LOG_REASON !== 'false',
    },
  };

  if (overrides) {
    return deepMerge(config, overrides);
  }
  return config;
}

/** 导出默认丢弃顺序 */
export { DEFAULT_DROP_ORDER };

// ─── 配置校验 ─────────────────────────────────────────────────────

export interface ConfigValidationError {
  path: string;
  message: string;
  /** 'warn' 表示回退默认值，'error' 表示应拒绝启动 */
  severity: 'warn' | 'error';
}

/**
 * P1#13: 校验压缩配置边界值。
 * - threshold/targetRatio 必须在 [0, 1]
 * - 各级 threshold 必须递增（l1 < l2 < l3 < l4 < l5）
 * - charsPerToken / forkMaxTokens / maxAttempts / cooldownTurns 必须 > 0
 * - retry.retries >= 0，retry.baseMs/maxMs > 0
 * - engine 字段非法时回退默认
 *
 * 默认仅 warn（不抛错），让 config 在生产环境即使配错也能启动。
 * 设 strict=true 时会抛出第一个 error 级问题。
 */
export function validateConfig(
  config: CompressionConfig,
  strict = false,
): ConfigValidationError[] {
  const errors: ConfigValidationError[] = [];

  const assertRange = (
    path: string,
    value: number,
    min: number,
    max: number,
    severity: 'warn' | 'error' = 'warn',
  ) => {
    if (!Number.isFinite(value) || value < min || value > max) {
      errors.push({ path, message: `${value} 不在 [${min}, ${max}] 范围`, severity });
    }
  };
  const assertPositive = (path: string, value: number, severity: 'warn' | 'error' = 'warn') => {
    if (!Number.isFinite(value) || value <= 0) {
      errors.push({ path, message: `${value} 必须 > 0`, severity });
    }
  };
  const assertNonNegative = (path: string, value: number, severity: 'warn' | 'error' = 'warn') => {
    if (!Number.isFinite(value) || value < 0) {
      errors.push({ path, message: `${value} 必须 >= 0`, severity });
    }
  };

  assertPositive('charsPerToken.ascii', config.charsPerToken.ascii);
  assertPositive('charsPerToken.cjk', config.charsPerToken.cjk);
  assertNonNegative('estimatorCacheCapacity', config.estimatorCacheCapacity);
  assertNonNegative('forkTimeoutMs', config.forkTimeoutMs);

  assertRange('l1.threshold', config.l1.threshold, 0, 1);
  assertRange('l1.targetRatio', config.l1.targetRatio, 0, 1);
  assertRange('l2.threshold', config.l2.threshold, 0, 1);
  assertRange('l2.targetRatio', config.l2.targetRatio, 0, 1);
  assertRange('l3.threshold', config.l3.threshold, 0, 1);
  assertRange('l3.targetRatio', config.l3.targetRatio, 0, 1);
  assertRange('l4.threshold', config.l4.threshold, 0, 1);
  assertRange('l4.targetRatio', config.l4.targetRatio, 0, 1);
  assertRange('l5.threshold', config.l5.threshold, 0, 1);

  assertPositive('l1.toolResultMaxLines', config.l1.toolResultMaxLines);
  assertPositive('l2.forkMaxTokens', config.l2.forkMaxTokens);
  assertPositive('l2.minResourcesToCompress', config.l2.minResourcesToCompress);
  assertNonNegative('l2.protectedRecentCount', config.l2.protectedRecentCount);
  assertPositive('l2.maxCompressionDepth', config.l2.maxCompressionDepth);
  assertPositive('l3.forkMaxTokens', config.l3.forkMaxTokens);
  assertNonNegative('l3.protectedRecentCount', config.l3.protectedRecentCount);
  assertNonNegative('l4.minWorkingSet', config.l4.minWorkingSet);
  assertPositive('l5.forkMaxTokens', config.l5.forkMaxTokens);

  assertPositive('safety.maxAttempts', config.safety.maxAttempts);
  assertNonNegative('safety.cooldownTurns', config.safety.cooldownTurns);
  assertNonNegative('safety.retry.retries', config.safety.retry.retries);
  assertPositive('safety.retry.baseMs', config.safety.retry.baseMs);
  assertPositive('safety.retry.maxMs', config.safety.retry.maxMs);

  // 各级 threshold 应单调递增（避免 L1 阈值比 L5 高导致顺序乱）
  const thresholds = [
    ['l1', config.l1.threshold],
    ['l2', config.l2.threshold],
    ['l3', config.l3.threshold],
    ['l4', config.l4.threshold],
    ['l5', config.l5.threshold],
  ] as const;
  for (let i = 1; i < thresholds.length; i++) {
    if (thresholds[i][1] < thresholds[i - 1][1]) {
      errors.push({
        path: `${thresholds[i][0]}.threshold`,
        message: `${thresholds[i][0]}.threshold=${thresholds[i][1]} 小于 ${thresholds[i - 1][0]}.threshold=${thresholds[i - 1][1]}，建议各级阈值单调递增`,
        severity: 'warn',
      });
    }
  }

  if (strict) {
    const firstError = errors.find(e => e.severity === 'error');
    if (firstError) {
      throw new Error(`[aipack-compression] Invalid config at ${firstError.path}: ${firstError.message}`);
    }
  }

  return errors;
}

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
