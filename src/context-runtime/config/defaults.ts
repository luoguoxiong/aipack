/**
 * ACR 默认配置
 *
 * 包含：
 * - 默认配置（DEFAULT_CONFIG）
 * - 三种预设配置文件（coding / research / assistant）
 * - 配置合并工具函数
 */

import type { ACRConfig } from '../types';

/** 默认配置 - 适用于大多数场景 */
export const DEFAULT_CONFIG: ACRConfig = {
  enabled: true,                            // 是否启用 ACR
  profile: 'coding',                         // 使用的配置文件
  integrate_with_progress_guard: true,       // 是否与进度守卫集成
  contextLimit: 128000,                      // 上下文 token 上限

  // 监控器配置
  monitors: {
    token: {
      enabled: true,
      attention: 0.60,    // 60% - 注意
      warning: 0.75,      // 75% - 警告（触发 L1 清理）
      critical: 0.88,     // 88% - 严重（触发 L2 窗口化）
      emergency: 0.96,    // 96% - 紧急（触发 L3 折叠）
      fatal: 0.99,        // 99% - 致命（触发 L5 紧急压缩）
    },
    valueDensity: {
      enabled: true,
      threshold: 0.40,          // 密度低于 40% 时触发压缩
      minTokensToCheck: 0.40,   // 至少达到 40% 上限才开始检查
    },
    contextEntropy: {
      enabled: true,
      windowSize: 10,              // 检查窗口大小
      efficiencyThreshold: 0.10,   // 效率阈值
      minToolCalls: 8,             // 至少 8 次工具调用才检查
    },
    phaseDetector: {
      enabled: true,
      compactOnPhaseChange: true,   // 阶段变化时触发压缩
      phaseChangeLevel: 'window',   // 阶段变化时使用的压缩级别
    },
    errorStorm: {
      enabled: true,
      consecutiveFailures: 5,     // 连续 5 次失败触发
      sameErrorThreshold: 3,      // 相同错误 3 次触发
      level: 'window',            // 使用的压缩级别
    },
    timeWindow: {
      enabled: true,
      intervalMinutes: 30,   // 每 30 分钟自动清理一次
      level: 'clean',        // 使用的压缩级别
    },
    workspaceObserver: {
      enabled: true,
      debounceMs: 2000,               // 防抖 2 秒
      checkIntervalMs: 30000,          // 检查间隔 30 秒
      useGit: true,                    // 使用 Git 作为真相源
      useFsWatch: false,               // 是否使用 fs.watch（P2 实现）
      fallbackToToolInference: true,   // Git 不可用时降级到工具推断
    },
  },

  // 压缩配置
  compression: {
    cooldown: {
      minTurnsBetweenSameLevel: 5,     // 同级别压缩之间至少间隔 5 轮
      maxCompressionsPerSession: 15,   // 每会话最多压缩 15 次
      allowLevelJump: false,           // 是否允许跳级压缩
      hysteresisRatio: 0.10,           // 滞回比例（压缩后需下降 10% 才再次触发）
      postCompressionCheck: true,      // 压缩后再次检查
    },
    strategies: {
      // L1 - 无损清理
      l1_clean: {
        deduplicate: true,                    // 去重
        deduplicate_tool_results: true,       // 去重工具结果
        deduplicate_assistant_messages: true, // 去重助手消息
        deduplicate_user_messages: false,     // 不去重用户消息
        remove_empty: true,                   // 移除空消息
        digest_tool_outputs: true,            // 生成工具输出摘要
      },
      // L2 - 窗口化
      l2_window: {
        recent_messages_to_keep: 12,           // 保留最近 12 条消息
        anchor_roles: ['system'],               // 锚点角色
        anchor_tags: ['goal', 'constraint', 'key_decision', 'current_error'],  // 锚点标签
        ensure_tool_pairing: true,              // 确保工具配对完整性
      },
      // L3 - 折叠
      l3_collapse: {
        fold_failed_attempts: true,          // 折叠失败尝试
        min_attempts_to_fold: 3,             // 至少 3 次才折叠
        max_attempts_in_summary: 10,         // 摘要中最多包含 10 次
        merge_repeated_reads: true,          // 合并重复读取
        min_reads_to_merge: 3,               // 至少 3 次才合并
        use_llm_summary: false,              // 是否使用 LLM 生成摘要（P1）
      },
      // L4 - 快照重写
      l4_snapshot_rewrite: {
        recent_keep: 5,                    // 保留最近 5 条
        rebuild_state_snapshot: true,       // 重建状态快照
        write_memories_before: true,        // 压缩前写入记忆
      },
      // L5 - 紧急压缩
      l5_emergency: {
        recent_keep: 2,               // 只保留最近 2 条
        minimal_state_only: true,      // 只保留最小化状态
      },
    },
    toolDigest: {
      max_tokens_per_digest: 500,   // 每个摘要最多 500 tokens
      default_rules: [
        {
          preservePatterns: [
            'error', 'Error', 'ERROR',
            'fail', 'Fail', 'FAIL',
            'success', 'Success',
            'pass', 'Pass', 'PASS',
            'Expected', 'Received',
            '✓', '✗', '×',
          ],
        },
        { headLines: 5 },
        { tailLines: 10 },
      ],
    },
    transitionMessages: {
      enabled: true,
      l1: '[系统] 已清理冗余内容（重复输出/过长日志已结构化），不影响继续。',
      l2: '[系统] 早期中间步骤已移出窗口，关键状态保留在 Agent State 中。可重新调用工具查看细节。',
      l3: '[系统] 连续失败尝试已折叠记录。请避免重复已失败的方法，换思路尝试。',
      l4: '[系统] 上下文已基于当前状态重建。核心信息在 State Snapshot 中，请基于当前状态继续。',
      l5: '[系统·紧急] 上下文已极限压缩。请查看 State Snapshot，换方案继续。',
    },
  },

  // 层级预算 - 各部分占用的 token 比例
  layerBudget: {
    system: 0,                // 系统提示词
    stateSnapshot: 0.15,      // 状态快照 15%
    currentPhase: 0.20,       // 当前阶段 20%
    recent: 0.30,             // 最近消息 30%
    toolDigests: 0.10,        // 工具摘要 10%
    historicalMemory: 0.05,   // 历史记忆 5%
    safetyMargin: 0.10,       // 安全余量 10%
  },

  // 记忆配置
  memory: {
    session: {
      enabled: true,
      autoUpdate: true,
      ttlMs: 86400000,  // 24 小时过期
    },
    workspace: {
      enabled: true,
      autoExtractArchitecture: true,    // 自动提取架构
      autoExtractCommands: true,        // 自动提取命令
      errorSolutions: true,             // 错误解决方案
      projectRootBound: true,           // 项目根目录绑定
    },
    user: {
      enabled: true,
      autoExtractPreferences: true,     // 自动提取偏好
      autoExtractFacts: true,           // 自动提取事实
      minImportanceToWrite: 0.7,        // 写入的最低重要度
    },
  },

  // 重要性权重配置
  importance: {
    weights: {
      semanticType: 0.30,     // 语义类型 30%
      stateImpact: 0.25,      // 状态影响 25%
      recency: 0.20,          // 新近性 20%
      errorRelevance: 0.15,   // 错误相关性 15%
      roleWeight: 0.05,       // 角色权重 5%
      goalRelevance: 0.05,    // 目标相关性 5%
    },
    tagWeights: {
      goal: 1.0,                // 目标 - 最高
      constraint: 0.95,         // 约束
      key_decision: 0.9,        // 关键决策
      current_error: 0.9,       // 当前错误
      state_change: 0.85,       // 状态变化
      success_result: 0.75,     // 成功结果
      failed_attempt: 0.2,      // 失败尝试
      temporary_output: 0.1,    // 临时输出
      duplicate: 0.0,           // 重复内容 - 最低
    },
  },

  // 可观测性配置
  observability: {
    debug: false,                    // 调试模式
    logCompressions: true,            // 记录压缩日志
    logHealthChecks: false,           // 记录健康检查
    emitMetrics: true,                // 发出指标
    keepCompressionHistory: 20,       // 保留 20 条压缩历史
    keepStateHistory: 5,              // 保留 5 条状态历史
  },
};

/**
 * 编码配置文件 - 用于软件开发任务
 * 特点：更积极的工具摘要、启用工作区观察、保留更多工具摘要空间
 */
export const CODING_PROFILE: Partial<ACRConfig> = {
  profile: 'coding',
  monitors: {
    ...DEFAULT_CONFIG.monitors,
    workspaceObserver: {
      ...DEFAULT_CONFIG.monitors.workspaceObserver,
      enabled: true,
    },
  },
  layerBudget: {
    system: 0,
    stateSnapshot: 0.15,
    currentPhase: 0.20,
    recent: 0.30,
    toolDigests: 0.20,    // 工具摘要占比更高（20%）
    historicalMemory: 0.05,
    safetyMargin: 0.10,
  },
};

/**
 * 研究配置文件 - 用于调查/学习任务
 * 特点：更保守的压缩阈值、保留更多历史上下文、禁用失败折叠
 */
export const RESEARCH_PROFILE: Partial<ACRConfig> = {
  profile: 'research',
  monitors: {
    ...DEFAULT_CONFIG.monitors,
    token: {
      ...DEFAULT_CONFIG.monitors.token,
      warning: 0.70,     // 更保守：70% 才警告
      critical: 0.85,
      emergency: 0.95,
    },
    valueDensity: {
      ...DEFAULT_CONFIG.monitors.valueDensity,
      threshold: 0.45,   // 密度阈值更高
    },
    contextEntropy: {
      ...DEFAULT_CONFIG.monitors.contextEntropy,
      efficiencyThreshold: 0.15,
      minToolCalls: 10,
    },
    workspaceObserver: {
      ...DEFAULT_CONFIG.monitors.workspaceObserver,
      enabled: false,    // 研究任务不需要工作区观察
    },
  },
  layerBudget: {
    system: 0,
    stateSnapshot: 0.10,
    currentPhase: 0.15,
    recent: 0.25,
    toolDigests: 0.25,
    historicalMemory: 0.15,   // 历史记忆占比更高（15%）
    safetyMargin: 0.10,
  },
  compression: {
    ...DEFAULT_CONFIG.compression,
    strategies: {
      ...DEFAULT_CONFIG.compression.strategies,
      l3_collapse: {
        ...DEFAULT_CONFIG.compression.strategies.l3_collapse,
        fold_failed_attempts: false,  // 研究任务不折叠失败尝试
      },
    },
  },
};

/**
 * 助手配置文件 - 用于一般对话
 * 特点：保留更多最近消息、禁用熵监控和工作区观察
 */
export const ASSISTANT_PROFILE: Partial<ACRConfig> = {
  profile: 'assistant',
  monitors: {
    ...DEFAULT_CONFIG.monitors,
    token: {
      ...DEFAULT_CONFIG.monitors.token,
      warning: 0.70,
      critical: 0.85,
      emergency: 0.95,
    },
    contextEntropy: {
      ...DEFAULT_CONFIG.monitors.contextEntropy,
      enabled: false,   // 对话任务不需要熵监控
    },
    workspaceObserver: {
      ...DEFAULT_CONFIG.monitors.workspaceObserver,
      enabled: false,   // 对话任务不需要工作区观察
    },
  },
  layerBudget: {
    system: 0,
    stateSnapshot: 0.10,
    currentPhase: 0.10,
    recent: 0.50,       // 最近消息占比最高（50%）
    toolDigests: 0.10,
    historicalMemory: 0.10,
    safetyMargin: 0.10,
  },
  compression: {
    ...DEFAULT_CONFIG.compression,
    strategies: {
      ...DEFAULT_CONFIG.compression.strategies,
      l2_window: {
        ...DEFAULT_CONFIG.compression.strategies.l2_window,
        recent_messages_to_keep: 20,  // 保留更多最近消息
      },
      l4_snapshot_rewrite: {
        ...DEFAULT_CONFIG.compression.strategies.l4_snapshot_rewrite,
        recent_keep: 6,
      },
      l5_emergency: {
        ...DEFAULT_CONFIG.compression.strategies.l5_emergency,
        recent_keep: 3,
      },
      l3_collapse: {
        ...DEFAULT_CONFIG.compression.strategies.l3_collapse,
        fold_failed_attempts: false,  // 对话任务不折叠失败
      },
    },
  },
};

/**
 * 根据配置文件名获取配置
 */
export function getProfileConfig(profile: string): Partial<ACRConfig> {
  switch (profile) {
    case 'coding':
      return CODING_PROFILE;
    case 'research':
      return RESEARCH_PROFILE;
    case 'assistant':
      return ASSISTANT_PROFILE;
    default:
      return {};
  }
}

/**
 * 合并配置 - 将 override 合并到 base 上
 * 深度合并，保留 base 中未被 override 覆盖的字段
 */
export function mergeConfig(base: ACRConfig, override: Partial<ACRConfig>): ACRConfig {
  return {
    ...base,
    ...override,
    monitors: {
      ...base.monitors,
      ...override.monitors,
      token: { ...base.monitors.token, ...override.monitors?.token },
      valueDensity: { ...base.monitors.valueDensity, ...override.monitors?.valueDensity },
      contextEntropy: { ...base.monitors.contextEntropy, ...override.monitors?.contextEntropy },
      phaseDetector: { ...base.monitors.phaseDetector, ...override.monitors?.phaseDetector },
      errorStorm: { ...base.monitors.errorStorm, ...override.monitors?.errorStorm },
      timeWindow: { ...base.monitors.timeWindow, ...override.monitors?.timeWindow },
      workspaceObserver: { ...base.monitors.workspaceObserver, ...override.monitors?.workspaceObserver },
    },
    compression: {
      ...base.compression,
      ...override.compression,
      cooldown: { ...base.compression.cooldown, ...override.compression?.cooldown },
      strategies: {
        ...base.compression.strategies,
        ...override.compression?.strategies,
        l1_clean: { ...base.compression.strategies.l1_clean, ...override.compression?.strategies?.l1_clean },
        l2_window: { ...base.compression.strategies.l2_window, ...override.compression?.strategies?.l2_window },
        l3_collapse: { ...base.compression.strategies.l3_collapse, ...override.compression?.strategies?.l3_collapse },
        l4_snapshot_rewrite: { ...base.compression.strategies.l4_snapshot_rewrite, ...override.compression?.strategies?.l4_snapshot_rewrite },
        l5_emergency: { ...base.compression.strategies.l5_emergency, ...override.compression?.strategies?.l5_emergency },
      },
      toolDigest: { ...base.compression.toolDigest, ...override.compression?.toolDigest },
      transitionMessages: { ...base.compression.transitionMessages, ...override.compression?.transitionMessages },
    },
    layerBudget: { ...base.layerBudget, ...override.layerBudget },
    memory: {
      ...base.memory,
      ...override.memory,
      session: { ...base.memory.session, ...override.memory?.session },
      workspace: { ...base.memory.workspace, ...override.memory?.workspace },
      user: { ...base.memory.user, ...override.memory?.user },
    },
    importance: {
      ...base.importance,
      ...override.importance,
      weights: { ...base.importance.weights, ...override.importance?.weights },
      tagWeights: { ...base.importance.tagWeights, ...override.importance?.tagWeights },
    },
    observability: { ...base.observability, ...override.observability },
  };
}
