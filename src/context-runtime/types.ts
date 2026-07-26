/**
 * Agent Context Runtime (ACR) v2.1 - 类型定义
 * Agent 上下文操作系统 - 核心类型定义
 */

import type { AgentMessage } from '../agent/types';

// ─── 枚举与字面量类型 ───

/** 任务阶段：标识 Agent 当前所处的工作阶段 */
export type TaskPhase =
  | 'requirement_analysis'  // 需求分析阶段
  | 'exploration'           // 探索阶段（阅读代码、搜索等）
  | 'planning'              // 规划阶段
  | 'implementation'        // 实现阶段（编码、修改文件）
  | 'verification'          // 验证阶段（运行测试、检查结果）
  | 'debugging'             // 调试阶段（修复问题）
  | 'refactoring'           // 重构阶段
  | 'documentation'         // 文档编写阶段
  | 'unknown';              // 未知阶段

/** 健康等级：用于描述上下文/token的健康状态 */
export type HealthLevel =
  | 'ok'         // 正常
  | 'attention'  // 注意（接近阈值）
  | 'warning'    // 警告（需要关注）
  | 'critical'   // 严重（需要处理）
  | 'emergency'  // 紧急（必须立即处理）
  | 'fatal';     // 致命（已超出限制）

/** 压缩级别：五级压缩策略，从无损到极限压缩 */
export type CompressionLevel =
  | 'clean'      // L1: 清理（去重、移除空消息、工具输出摘要）
  | 'window'     // L2: 窗口（锚点+滑动窗口）
  | 'collapse'   // L3: 折叠（失败尝试折叠、重复读取合并）
  | 'snapshot'   // L4: 快照（基于状态快照重建上下文）
  | 'emergency'; // L5: 紧急（极限压缩，仅保留最小状态）

/** 消息标签：用于标识消息的语义类型和重要性 */
export type MessageTag =
  | 'goal'              // 目标相关
  | 'constraint'        // 约束条件
  | 'key_decision'      // 关键决策
  | 'current_error'     // 当前错误
  | 'state_change'      // 状态变更
  | 'success_result'    // 成功结果
  | 'failed_attempt'    // 失败尝试
  | 'temporary_output'  // 临时输出
  | 'duplicate';        // 重复内容

/** 记忆层：三层记忆体系 */
export type MemoryLayer =
  | 'session'    // 会话层记忆（当前会话）
  | 'workspace'  // 工作区记忆（项目级）
  | 'user';      // 用户层记忆（用户偏好）

/** ACR 配置场景配置文件 */
export type ACRProfile =
  | 'coding'      // 编码场景
  | 'research'    // 研究/探索场景
  | 'assistant'   // 通用助手场景
  | 'custom';     // 自定义配置

// ─── Agent 状态类型 ───

/** 文件状态：跟踪单个文件的变更情况 */
export interface FileState {
  path: string;                    // 文件路径
  status: 'modified' | 'created' | 'deleted';  // 文件状态：修改/创建/删除
  diffSummary?: string;            // 差异摘要（可选）
  lastToolTouch?: string;          // 最后操作该文件的工具名
}

/** Git 状态：代码仓库的 Git 状态信息 */
export interface GitStatus {
  branch: string;       // 当前分支名
  ahead: number;        // 领先远程的提交数
  behind: number;       // 落后远程的提交数
  staged: string[];     // 已暂存的文件列表
  unstaged: string[];   // 未暂存的文件列表
  untracked: string[];  // 未追踪的文件列表
}

/** 测试状态：测试运行结果统计 */
export interface TestStatus {
  lastRun?: number;        // 上次运行时间戳
  total?: number;          // 总测试数
  passed?: number;         // 通过数
  failed?: number;         // 失败数
  failingTests?: string[]; // 失败的测试用例列表
}

/** 约束条件：任务中的约束/规则 */
export interface Constraint {
  content: string;                    // 约束内容
  source: 'user' | 'system' | 'decision';  // 来源：用户/系统/决策
  priority: 'critical' | 'high' | 'medium';  // 优先级
}

/** 决策记录：记录关键决策及其原因 */
export interface Decision {
  decision: string;   // 决策内容
  reason: string;     // 决策原因
  timestamp: number;  // 决策时间戳
}

/** 尝试过的策略：记录已尝试的方法及其结果 */
export interface AttemptedStrategy {
  strategy: string;                  // 策略名称/描述
  result: 'success' | 'failed' | 'partial';  // 结果：成功/失败/部分成功
  reason?: string;                   // 原因说明（可选）
}

/** 错误状态：跟踪错误信息 */
export interface ErrorState {
  error: string;          // 错误信息
  errorType: string;      // 错误类型（如 SyntaxError、Timeout 等）
  source: string;         // 错误来源（工具名）
  resolved: boolean;      // 是否已解决
  firstSeen: number;      // 首次出现时间
  occurrenceCount: number;  // 出现次数
}

/** 失败尝试：记录失败的操作 */
export interface FailedAttempt {
  action: string;         // 操作描述
  target: string;         // 操作目标
  failureReason: string;  // 失败原因
  errorType: string;      // 错误类型
}

/** 关键发现：研究/探索中的重要发现 */
export interface KeyFinding {
  content: string;    // 发现内容
  source: string;     // 来源
  relevance: number;  // 相关性评分（0-1）
}

/** 工作区状态：整个工作区的状态汇总 */
export interface WorkspaceState {
  modifiedFiles: FileState[];  // 已修改的文件列表
  createdFiles: string[];      // 已创建的文件列表
  deletedFiles: string[];      // 已删除的文件列表
  gitStatus: GitStatus;        // Git 状态
  gitDiffSummary: string;      // Git 差异摘要
  testStatus: TestStatus;      // 测试状态
}

/** Agent 状态元数据：状态快照的元信息 */
export interface AgentStateMetadata {
  snapshotVersion: number;   // 快照版本号（每次压缩递增）
  lastUpdated: number;       // 最后更新时间
  compressionCount: number;  // 已执行的压缩次数
}

/** Agent 状态：完整的 Agent 心智状态模型 */
export interface AgentState {
  task: {
    goal: string;           // 当前任务目标
    phase: TaskPhase;       // 当前任务阶段
    status: 'running' | 'blocked' | 'completed';  // 任务状态
    startTime: number;      // 任务开始时间
    elapsedMs: number;      // 已耗时（毫秒）
  };
  completedTasks: string[];      // 已完成的任务列表
  nextActions: string[];         // 下一步行动计划
  attemptedStrategies: AttemptedStrategy[];  // 已尝试的策略
  constraints: Constraint[];     // 约束条件列表
  decisions: Decision[];         // 决策记录
  workspace: WorkspaceState;     // 工作区状态
  errors: ErrorState[];          // 错误列表
  failedAttempts: FailedAttempt[];  // 失败尝试记录
  keyFindings?: KeyFinding[];    // 关键发现（可选）
  metadata: AgentStateMetadata;  // 元数据
}

// ─── 工作区观察者类型 ───

/** 工作区观察者状态：从 Git/文件系统观察到的工作区状态 */
export interface WorkspaceObserverState {
  git: {
    branch: string;           // 当前分支
    status: 'clean' | 'dirty';  // 仓库状态：干净/有变更
    modified: string[];       // 已修改文件
    staged: string[];         // 已暂存文件
    untracked: string[];      // 未追踪文件
    ahead: number;            // 领先提交数
    behind: number;           // 落后提交数
    lastCommit?: string;      // 最后一次提交信息
    diffSummary: string;      // diff 统计摘要
  };
  filesystem: {
    recentlyModified: { path: string; mtime: number }[];  // 最近修改的文件
    recentlyCreated: string[];   // 最近创建的文件
    recentlyDeleted: string[];   // 最近删除的文件
  };
  tests?: {
    lastRunAt: number;       // 上次测试运行时间
    framework?: string;      // 测试框架
    passed: number;          // 通过数
    failed: number;          // 失败数
    failingTests: string[];  // 失败的测试
  };
  lastChecked: number;  // 最后检查时间
  source: 'git_status' | 'filesystem_watch' | 'tool_inference';  // 数据来源
}

// ─── 监控器类型 ───

/** Token 健康状态：token 使用情况 */
export interface TokenHealth {
  used: number;     // 已使用的 token 数
  limit: number;    // token 上限
  ratio: number;    // 使用比例（0-1）
  level: HealthLevel;  // 健康等级
}

/** 价值密度：衡量上下文中高价值内容的比例 */
export interface ValueDensity {
  density: number;  // 密度值（0-1，越高越好）
  signals: {
    duplicateToolResults: number;      // 重复的工具结果数
    redundantReads: number;            // 冗余的文件读取数
    emptyOrTrivialOutputs: number;     // 空或无意义的输出数
    staleErrors: number;               // 过时的错误数
    longTemporaryOutputs: number;      // 过长的临时输出数
  };
}

/** 上下文熵：衡量上下文的变化和探索效率 */
export interface ContextEntropy {
  toolCallsInWindow: number;         // 窗口内的工具调用数
  stateChangesInWindow: number;      // 窗口内的状态变化数
  newErrorsInWindow: number;         // 窗口内的新错误数
  uniqueResourcesTouched: number;    // 接触过的唯一资源数
  repeatedResourceReads: number;     // 重复读取资源的次数
  isInLowValueExploration: boolean;  // 是否处于低价值探索中
  explorationEfficiency: number;     // 探索效率（0-1）
}

/** 健康快照：综合健康状态快照 */
export interface HealthSnapshot {
  token: TokenHealth;        // Token 健康
  density: ValueDensity;     // 价值密度
  entropy: ContextEntropy;   // 上下文熵
  phase: TaskPhase;          // 当前任务阶段
  overall: HealthLevel;      // 总体健康等级
}

// ─── 工具摘要类型 ───

/** 工具摘要：工具输出的结构化摘要 */
export interface ToolDigest {
  tool: string;               // 工具名称
  status: 'success' | 'failed';  // 执行状态
  summary: string;            // 摘要内容
  filesChanged: string[];     // 涉及的文件
  errors: string[];           // 错误列表
  importantLines: string[];   // 重要行
  outputHash: string;         // 输出内容的哈希（用于去重）
  originalLength: number;     // 原始长度（字符数）
  digestLength: number;       // 摘要长度（字符数）
}

// ─── 重要性引擎类型 ───

/** 重要性评分：消息的重要性评估结果 */
export interface ImportanceScore {
  score: number;  // 总分（0-1）
  factors: {
    recency: number;       // 时效性因子
    roleWeight: number;    // 角色权重
    semanticType: number;  // 语义类型权重
    stateImpact: number;   // 状态影响权重
    errorRelevance: number;  // 错误相关性
    goalRelevance: number;   // 目标相关性
  };
  tags: MessageTag[];  // 消息标签
}

// ─── 记忆类型 ───

/** 会话记忆：当前会话的记忆 */
export interface SessionMemory {
  sessionId: string;           // 会话 ID
  agentState: AgentState;      // Agent 状态
  recentContext: AgentMessage[];  // 最近的上下文消息
  toolDigests: ToolDigest[];   // 工具摘要列表
  createdAt: number;           // 创建时间
  updatedAt: number;           // 更新时间
}

/** 工作区记忆：项目级的长期记忆 */
export interface WorkspaceMemory {
  projectRoot: string;  // 项目根目录
  architecture: {
    entryPoints: string[];                  // 入口文件列表
    keyDirectories: Record<string, string>;  // 关键目录说明
    frameworks: string[];                   // 使用的框架
    conventions: string[];                  // 代码规范/约定
  };
  commands: {
    test?: string;   // 测试命令
    build?: string;  // 构建命令
    dev?: string;    // 开发命令
    lint?: string;   // 代码检查命令
  };
  patterns: {
    pattern: string;      // 模式
    description: string;  // 描述
    source: string;       // 来源
  }[];
  errorSolutions: {
    error: string;     // 错误信息
    solution: string;  // 解决方案
    files: string[];   // 相关文件
  }[];
}

/** 用户记忆：用户级的长期记忆 */
export interface UserMemory {
  userId: string;  // 用户 ID
  preferences: {
    language: string;                          // 语言偏好
    codingStyle?: string;                      // 编码风格
    commentStyle?: 'minimal' | 'detailed' | 'none';  // 注释风格
    testFramework?: string;                    // 测试框架偏好
    packageManager?: 'npm' | 'yarn' | 'pnpm' | 'bun';  // 包管理器偏好
  };
  constraints: string[];                    // 用户约束
  facts: { fact: string; learnedAt: number }[];  // 学到的事实
}

/** 记忆写入操作：向记忆层写入数据的请求 */
export interface MemoryWrite {
  layer: MemoryLayer;    // 目标记忆层
  content: unknown;      // 写入内容
  type?: string;         // 内容类型
  importance: number;    // 重要性（0-1）
  ttl?: number;          // 存活时间（毫秒）
}

// ─── 压缩结果类型 ───

/** 压缩结果：一次压缩操作的完整结果 */
export interface CompressionResult {
  success: boolean;           // 是否成功
  level: CompressionLevel;    // 使用的压缩级别
  trigger: string;            // 触发原因
  strategiesUsed: string[];   // 使用的策略列表
  tokensBefore: number;       // 压缩前 token 数
  tokensAfter: number;        // 压缩后 token 数
  tokensSaved: number;        // 节省的 token 数
  compressionRatio: number;   // 压缩率（节省比例）
  messagesBefore: number;     // 压缩前消息数
  messagesAfter: number;      // 压缩后消息数
  durationMs: number;         // 压缩耗时（毫秒）
  stateVersion: number;       // 状态版本号
  transitionMessage?: string;  // 过渡消息内容
  failedAttemptsFolded?: number;  // 折叠的失败尝试数
  toolDigestsCreated?: number;    // 创建的工具摘要数
  memoryWrites?: { session: number; workspace: number; user: number };  // 记忆写入数
  error?: string;  // 错误信息（失败时）
}

/** 压缩选项：手动触发压缩时的选项 */
export interface CompactOptions {
  level?: CompressionLevel;  // 指定压缩级别
  trigger?: string;          // 触发原因
  force?: boolean;           // 是否强制压缩（忽略冷却）
}

// ─── 配置类型 ───

/** Token 监控器配置 */
export interface TokenMonitorConfig {
  enabled: boolean;     // 是否启用
  attention: number;    // 注意阈值（比例）
  warning: number;      // 警告阈值
  critical: number;     // 严重阈值
  emergency: number;    // 紧急阈值
  fatal: number;        // 致命阈值
}

/** 价值密度监控器配置 */
export interface ValueDensityConfig {
  enabled: boolean;         // 是否启用
  threshold: number;        // 触发压缩的密度阈值
  minTokensToCheck: number; // 开始检查的最小 token 数（比例）
}

/** 上下文熵监控器配置 */
export interface ContextEntropyConfig {
  enabled: boolean;            // 是否启用
  windowSize: number;          // 窗口大小（消息数）
  efficiencyThreshold: number; // 效率阈值
  minToolCalls: number;        // 最少工具调用数
}

/** 阶段检测器配置 */
export interface PhaseDetectorConfig {
  enabled: boolean;                // 是否启用
  compactOnPhaseChange: boolean;   // 阶段变化时是否压缩
  phaseChangeLevel: CompressionLevel;  // 阶段变化时的压缩级别
}

/** 错误风暴检测配置 */
export interface ErrorStormConfig {
  enabled: boolean;            // 是否启用
  consecutiveFailures: number; // 连续失败次数阈值
  sameErrorThreshold: number;  // 相同错误次数阈值
  level: CompressionLevel;     // 触发的压缩级别
}

/** 时间窗口配置：定时压缩 */
export interface TimeWindowConfig {
  enabled: boolean;             // 是否启用
  intervalMinutes: number;      // 间隔时间（分钟）
  level: CompressionLevel;      // 压缩级别
}

/** 工作区观察者配置 */
export interface WorkspaceObserverConfig {
  enabled: boolean;                  // 是否启用
  debounceMs: number;                // 防抖时间（毫秒）
  checkIntervalMs: number;           // 检查间隔（毫秒）
  useGit: boolean;                   // 是否使用 Git 状态
  useFsWatch: boolean;               // 是否使用文件系统监听
  fallbackToToolInference: boolean;  // 是否回退到工具推断
}

/** 监控器总配置 */
export interface MonitorConfig {
  token: TokenMonitorConfig;              // Token 监控
  valueDensity: ValueDensityConfig;       // 价值密度监控
  contextEntropy: ContextEntropyConfig;   // 上下文熵监控
  phaseDetector: PhaseDetectorConfig;     // 阶段检测器
  errorStorm: ErrorStormConfig;           // 错误风暴检测
  timeWindow: TimeWindowConfig;           // 时间窗口
  workspaceObserver: WorkspaceObserverConfig;  // 工作区观察者
}

/** 冷却机制配置：防止频繁压缩 */
export interface CooldownConfig {
  minTurnsBetweenSameLevel: number;  // 同级压缩间的最小回合数
  maxCompressionsPerSession: number; // 单会话最大压缩次数
  allowLevelJump: boolean;           // 是否允许跳级
  hysteresisRatio: number;           // 滞后比率（防止抖动）
  postCompressionCheck: boolean;     // 压缩后检查
}

/** L1 清理策略配置 */
export interface L1CleanConfig {
  deduplicate: boolean;                    // 是否去重
  deduplicate_tool_results: boolean;       // 是否去重工具结果
  deduplicate_assistant_messages: boolean; // 是否去重助手消息
  deduplicate_user_messages: boolean;      // 是否去重用户消息
  remove_empty: boolean;                   // 是否移除空消息
  digest_tool_outputs: boolean;            // 是否生成工具输出摘要
}

/** L2 窗口策略配置 */
export interface L2WindowConfig {
  recent_messages_to_keep: number;  // 保留的最近消息数
  anchor_roles: string[];           // 锚点角色
  anchor_tags: MessageTag[];        // 锚点标签
  ensure_tool_pairing: boolean;     // 是否确保工具配对
}

/** L3 折叠策略配置 */
export interface L3CollapseConfig {
  fold_failed_attempts: boolean;     // 是否折叠失败尝试
  min_attempts_to_fold: number;      // 触发折叠的最少尝试数
  max_attempts_in_summary: number;   // 摘要中保留的最大尝试数
  merge_repeated_reads: boolean;     // 是否合并重复读取
  min_reads_to_merge: number;        // 触发合并的最少读取数
  use_llm_summary: boolean;          // 是否使用 LLM 生成摘要
}

/** L4 快照策略配置 */
export interface L4SnapshotConfig {
  recent_keep: number;              // 保留的最近消息数
  rebuild_state_snapshot: boolean;  // 是否重建状态快照
  write_memories_before: boolean;   // 压缩前是否写入记忆
}

/** L5 紧急策略配置 */
export interface L5EmergencyConfig {
  recent_keep: number;          // 保留的最近消息数
  minimal_state_only: boolean;  // 是否仅保留最小状态
}

/** 压缩策略总配置 */
export interface StrategyConfig {
  l1_clean: L1CleanConfig;                    // L1 清理
  l2_window: L2WindowConfig;                  // L2 窗口
  l3_collapse: L3CollapseConfig;              // L3 折叠
  l4_snapshot_rewrite: L4SnapshotConfig;      // L4 快照
  l5_emergency: L5EmergencyConfig;            // L5 紧急
}

/** 工具摘要器配置 */
export interface ToolDigestConfig {
  max_tokens_per_digest: number;  // 每个摘要的最大 token 数
  default_rules: {
    preservePatterns?: string[];  // 需要保留的模式
    headLines?: number;           // 保留开头行数
    tailLines?: number;           // 保留结尾行数
  }[];
}

/** 过渡消息配置：压缩后显示的提示消息 */
export interface TransitionMessagesConfig {
  enabled: boolean;  // 是否启用
  l1: string;        // L1 过渡消息
  l2: string;        // L2 过渡消息
  l3: string;        // L3 过渡消息
  l4: string;        // L4 过渡消息
  l5: string;        // L5 过渡消息
}

/** 压缩总配置 */
export interface CompressionConfig {
  cooldown: CooldownConfig;            // 冷却机制
  strategies: StrategyConfig;          // 压缩策略
  toolDigest: ToolDigestConfig;        // 工具摘要
  transitionMessages: TransitionMessagesConfig;  // 过渡消息
}

/** 层级预算：各层级的 token 预算分配 */
export interface LayerBudget {
  system: number;            // 系统提示
  stateSnapshot: number;     // 状态快照
  currentPhase: number;      // 当前阶段信息
  recent: number;            // 最近消息
  toolDigests: number;       // 工具摘要
  historicalMemory: number;  // 历史记忆
  safetyMargin: number;      // 安全余量
}

/** 记忆配置 */
export interface MemoryConfig {
  session: {
    enabled: boolean;      // 是否启用
    autoUpdate: boolean;   // 是否自动更新
    ttlMs?: number;        // 存活时间
  };
  workspace: {
    enabled: boolean;                    // 是否启用
    autoExtractArchitecture: boolean;    // 是否自动提取架构
    autoExtractCommands: boolean;        // 是否自动提取命令
    errorSolutions: boolean;             // 是否记录错误解决方案
    projectRootBound: boolean;           // 是否绑定项目根目录
  };
  user: {
    enabled: boolean;                // 是否启用
    autoExtractPreferences: boolean; // 是否自动提取偏好
    autoExtractFacts: boolean;       // 是否自动提取事实
    minImportanceToWrite: number;    // 写入的最小重要性
  };
}

/** 重要性评估配置 */
export interface ImportanceConfig {
  weights: {
    semanticType: number;   // 语义类型权重
    stateImpact: number;    // 状态影响权重
    recency: number;        // 时效性权重
    errorRelevance: number; // 错误相关性权重
    roleWeight: number;     // 角色权重
    goalRelevance: number;  // 目标相关性权重
  };
  tagWeights: Record<MessageTag, number>;  // 各标签的权重
}

/** 可观测性配置 */
export interface ObservabilityConfig {
  debug: boolean;                    // 是否开启调试模式
  logCompressions: boolean;          // 是否记录压缩日志
  logHealthChecks: boolean;          // 是否记录健康检查
  emitMetrics: boolean;              // 是否发出指标
  keepCompressionHistory: number;    // 保留的压缩历史记录数
  keepStateHistory: number;          // 保留的状态历史记录数
}

/** ACR 完整配置 */
export interface ACRConfig {
  enabled: boolean;                    // 是否启用 ACR
  profile: ACRProfile;                 // 使用的配置场景
  integrate_with_progress_guard: boolean;  // 是否与进度守卫集成
  contextLimit: number;                // 上下文 token 限制
  monitors: MonitorConfig;             // 监控器配置
  compression: CompressionConfig;      // 压缩配置
  layerBudget: LayerBudget;            // 层级预算
  memory: MemoryConfig;                // 记忆配置
  importance: ImportanceConfig;        // 重要性配置
  observability: ObservabilityConfig;  // 可观测性配置
}

// ─── 事件类型 ───

/** ACR 事件类型 */
export type ACREventType =
  | 'health_check'         // 健康检查
  | 'compression_start'    // 压缩开始
  | 'compression_complete' // 压缩完成
  | 'state_updated'        // 状态更新
  | 'workspace_updated'    // 工作区更新
  | 'memory_write'         // 记忆写入
  | 'tool_digested';       // 工具摘要生成

/** ACR 事件 */
export interface ACREvent {
  type: ACREventType;  // 事件类型
  timestamp: number;   // 时间戳
  data?: unknown;      // 事件数据
}

// ─── 默认各层级保留的最近消息数 ───
/** 各压缩级别保留的最近消息数常量 */
export const RECENT_KEEP = {
  l2: 12,  // L2 窗口级别保留 12 条
  l3: 8,   // L3 折叠级别保留 8 条
  l4: 5,   // L4 快照级别保留 5 条
  l5: 2,   // L5 紧急级别保留 2 条
} as const;
