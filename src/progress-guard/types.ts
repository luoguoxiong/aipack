/**
 * Agent Progress Guard (APG) — 类型定义
 * Agent Runtime 控制平面，检测进展停滞并自动干预
 */

// ─── 资源类型 ───

export type ResourceType =
  | 'file'
  | 'api'
  | 'database'
  | 'memory'
  | 'browser'
  | 'workflow'
  | 'other';

// ─── 工具意图 ───

export type ToolIntent =
  | 'READ'
  | 'MODIFY'
  | 'VERIFY'
  | 'RESEARCH'
  | 'MEMORY'
  | 'SCHEDULE'
  | 'OTHER';

/** 工具 → Intent 映射表 */
export type ToolIntentMap = Record<string, { intent: ToolIntent; resourceType: ResourceType }>;

// ─── 执行轨迹 ───

export interface TraceStep {
  id: number;
  turnIndex: number;
  type: 'assistant' | 'tool_call' | 'tool_result';

  // 工具
  toolName?: string;
  toolIntent?: ToolIntent;
  inputHash?: string;
  outputHash?: string;

  // 资源
  resourceType?: ResourceType;
  resourceId?: string;
  targetKey?: string;

  // 效果
  success: boolean;
  errorHash?: string;
  errorType?: string;

  // 状态
  stateBefore: string;
  stateAfter: string;
  stateChanged: boolean;

  // 元数据
  timestamp: number;
  durationMs: number;
  tokensUsed?: number;

  // 文本输出 (用于语义分析)
  textOutput?: string;
  textLength?: number;
}

export interface ExecutionTrace {
  steps: TraceStep[];
  windowSize: number;
  totalSteps: number;
}

// ─── 资源状态 ───

export interface ResourceState {
  type: ResourceType;
  id: string;
  hash: string;
  lastModified: number;
  accessCount: number;
  modifyCount: number;
}

export interface StateSnapshot {
  resources: Record<string, ResourceState>;
  stateHash: string;
  modifiedCount: number;
  errorHash: string;
  timestamp: number;
}

// ─── 进展评分 ───

export interface ProgressSignals {
  stateChange: number;
  infoGain: number;
  errorMovement: number;
  novelty: number;
  outputGrowth: number;
}

export interface ProgressScore {
  score: number;
  trend: 'up' | 'down' | 'flat';
  signals: ProgressSignals;
}

// ─── 预算状态 ───

export interface BudgetState {
  tokens: number;
  cost: number;
  toolCalls: number;
  turns: number;
  durationMs: number;
  maxTokens?: number;
  maxToolCalls?: number;
  maxTurns?: number;
  maxDurationMs?: number;
}

// ─── 检测策略 ───

export interface DetectionResult {
  detected: boolean;
  confidence: number;
  pattern?: string;
  evidenceIndices?: number[];
  detail?: string;
}

export type StrategyName =
  | 'state_freeze'
  | 'error_loop'
  | 'tool_cycle'
  | 'action_repeat'
  | 'progress_stagnation'
  | 'budget_waste'
  | 'semantic';

// ─── 风险等级 ───

export type RiskLevel = 'normal' | 'suspicious' | 'stuck' | 'failed';

export interface RiskAssessment {
  level: RiskLevel;
  score: number;
  reasons: string[];
  evidence: {
    strategy: StrategyName;
    confidence: number;
    detail: string;
  }[];
  consecutiveTurns: number;
  firstDetectedTurn: number;
}

// ─── Agent Profile ───

export type AgentProfile = 'coding' | 'research' | 'assistant' | 'workflow';

// ─── 白名单 ───

export interface WhitelistConfig {
  batchOperation: boolean;
  longThinkingChain: boolean;
  selfCorrectionRetries: number;
  allowedRepeatTools: string[];
  allowedResourceTypes: ResourceType[];
}

export interface WhitelistCheckResult {
  exempt: boolean;
  reason?: string;
  matchedRule?: string;
}

// ─── 干预 ───

export type InterventionLevel = 'none' | 'reflection' | 'context_reset' | 'tool_restriction' | 'terminate';

export interface InterventionEvent {
  level: RiskLevel;
  action: InterventionLevel;
  message?: string;
  restrictedTools?: string[];
  timestamp: number;
}

// ─── 恢复状态机 ───

export interface RecoveryState {
  currentLevel: RiskLevel;
  currentIntervention: InterventionLevel;
  consecutiveHighRiskTurns: number;
  consecutiveLowRiskTurns: number;
  firstDetectedTurn: number;
  interventionCount: number;
  lastInterventionTurn: number;
  stuckRetries: number;
  restrictedTools: Set<string>;
}

// ─── 诊断报告 ───

export interface ProgressDiagnosis {
  riskLevel: RiskLevel;
  riskScore: number;
  firstDetectedTurn: number;
  stuckDurationTurns: number;
  tokensWasted: number;
  strategyBreakdown: {
    strategy: StrategyName;
    confidence: number;
    detail: string;
  }[];
  progressTrend: {
    turn: number;
    score: number;
  }[];
  detectedPatterns: string[];
  whitelistChecks: {
    name: string;
    matched: boolean;
    detail?: string;
  }[];
  suggestedAction: string;
}

// ─── 失败报告 ───

export interface FailureReport {
  reason: string;
  riskLevel: 'failed';
  diagnosis: {
    firstDetectedTurn: number;
    stuckDurationTurns: number;
    tokensWasted: number;
    patterns: string[];
    strategyBreakdown: {
      strategy: StrategyName;
      confidence: number;
      detail: string;
    }[];
  };
  stateSnapshot: {
    modifiedResources: string[];
    lastError?: string;
  };
  suggestion: string;
}

// ─── 配置 ───

export interface ProgressGuardConfig {
  enabled: boolean;
  profile: AgentProfile;
  windowSize: number;
  minTurnsBeforeDetect: number;

  thresholds: {
    suspicious: number;
    stuck: number;
    failed: number;
  };

  stateMachine: {
    confirmationTurns: number;
    downgradeTurns: number;
  };

  strategyWeights: Record<StrategyName, number>;
  strategies: StrategyName[];

  toolIntents: ToolIntentMap;

  whitelist: WhitelistConfig;

  recovery: {
    suspicious: { action: 'reflection'; cooldownTurns: number };
    stuck: { actions: ('context_reset' | 'tool_restriction')[]; maxRetries: number };
    failed: { action: 'terminate' };
  };

  budget: {
    enabled: boolean;
    maxTokens?: number;
    maxToolCalls?: number;
    maxTurns?: number;
    efficiencyThreshold: number;
  };

  // P3: 自适应权重
  adaptiveWeights: {
    enabled: boolean;
    learningRate: number;
    historySize: number;
  };

  // P3: 语义分析
  semantic: {
    enabled: boolean;
    ngramSize: number;
    similarityThreshold: number;
  };

  // P3: Dashboard
  dashboard: {
    enabled: boolean;
    historySize: number;
  };

  debug: boolean;
}

// ─── Metrics ───

export interface MetricsSnapshot {
  riskScore: number;
  riskLevel: RiskLevel;
  progressScore: number;
  tokensTotal: number;
  interventionTotal: number;
  detectedTotal: number;
  tokensWastedTotal: number;
  whitelistHitsTotal: number;
  recoveryTurns: number[];
}

// ─── 事件 ───

export type ProgressGuardEvent =
  | { type: 'risk_change'; level: RiskLevel; score: number; previousLevel: RiskLevel }
  | { type: 'intervention'; level: RiskLevel; action: InterventionLevel; message?: string }
  | { type: 'diagnosis'; diagnosis: ProgressDiagnosis }
  | { type: 'progress_update'; score: number; trend: string; turn: number }
  | { type: 'recovery'; from: RiskLevel; to: RiskLevel };

// ─── 自适应权重 (P3) ───

export interface AdaptiveWeightState {
  weights: Record<StrategyName, number>;
  history: {
    turn: number;
    features: Record<StrategyName, number>;
    wasLoop: boolean;
    interventionWorked: boolean;
  }[];
}
