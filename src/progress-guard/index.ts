/**
 * Agent Progress Guard — 主入口
 * Agent Runtime 控制平面
 */

import type {
  ProgressGuardConfig,
  ProgressGuardEvent,
  RiskLevel,
  InterventionLevel,
  ProgressDiagnosis,
  FailureReport,
  BudgetState,
  TraceStep,
  StrategyName,
  AgentProfile,
} from './types';
import { TraceCollector } from './trace-collector';
import { StateEngine } from './state-engine';
import { computeProgressScore } from './progress-analyzer';
import { RiskEngine } from './risk-engine';
import { RecoveryController } from './recovery-controller';
import { Metrics } from './metrics';
import { AdaptiveWeights } from './adaptive-weights';
import { SemanticAnalyzer } from './semantic-analyzer';

/** 默认配置 */
export const DEFAULT_CONFIG: ProgressGuardConfig = {
  enabled: true,
  profile: 'assistant',
  windowSize: 20,
  minTurnsBeforeDetect: 3,

  thresholds: {
    suspicious: 0.4,
    stuck: 0.7,
    failed: 0.9,
  },

  stateMachine: {
    confirmationTurns: 2,
    downgradeTurns: 3,
  },

  strategyWeights: {
    state_freeze: 0.35,
    error_loop: 0.30,
    tool_cycle: 0.15,
    progress_stagnation: 0.10,
    budget_waste: 0.10,
    action_repeat: 0.05,
    semantic: 0.05,
  },

  strategies: [
    'state_freeze',
    'error_loop',
    'tool_cycle',
    'action_repeat',
    'progress_stagnation',
    'budget_waste',
    'semantic',
  ],

  toolIntents: {},

  whitelist: {
    batchOperation: true,
    longThinkingChain: true,
    selfCorrectionRetries: 3,
    allowedRepeatTools: ['read_file', 'web_search'],
    allowedResourceTypes: [],
  },

  recovery: {
    suspicious: { action: 'reflection', cooldownTurns: 3 },
    stuck: { actions: ['context_reset', 'tool_restriction'], maxRetries: 2 },
    failed: { action: 'terminate' },
  },

  budget: {
    enabled: true,
    efficiencyThreshold: 50000,
  },

  adaptiveWeights: {
    enabled: true,
    learningRate: 0.01,
    historySize: 100,
  },

  semantic: {
    enabled: true,
    ngramSize: 3,
    similarityThreshold: 0.85,
  },

  dashboard: {
    enabled: true,
    historySize: 50,
  },

  debug: false,
};

export class ProgressGuard {
  private config: ProgressGuardConfig;
  private collector: TraceCollector;
  private stateEngine: StateEngine;
  private riskEngine: RiskEngine;
  private recoveryController: RecoveryController;
  private metrics: Metrics;
  private adaptiveWeights: AdaptiveWeights;
  private semanticAnalyzer: SemanticAnalyzer;

  // 事件
  private eventListeners: ((event: ProgressGuardEvent) => void)[] = [];

  // 内部状态
  private currentTurn = 0;
  private previousProgressScore = 0.5;
  private budget: BudgetState;
  private attached = false;
  private steerFn: ((message: string) => void) | null = null;
  private abortFn: ((reason: string) => void) | null = null;
  private toolBlockFn: ((toolName: string, args: unknown) => boolean) | null = null;

  // Dashboard 历史 (P3)
  private dashboardHistory: { turn: number; riskScore: number; progressScore: number; level: RiskLevel }[] = [];

  constructor(config: Partial<ProgressGuardConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.collector = new TraceCollector(this.config.windowSize, this.config.toolIntents);
    this.stateEngine = new StateEngine();
    this.riskEngine = new RiskEngine(this.config);
    this.recoveryController = new RecoveryController(this.config);
    this.metrics = new Metrics();
    this.adaptiveWeights = new AdaptiveWeights(this.config);
    // 应用 Profile 覆盖权重
    if (config.profile && config.profile !== 'assistant') {
      // RiskEngine 内部已处理 Profile 覆盖
    }
    this.semanticAnalyzer = new SemanticAnalyzer(
      this.config.semantic.ngramSize,
      this.config.semantic.similarityThreshold,
    );
    this.budget = this.createInitialBudget();
  }

  // ─── 公开 API ───

  /** 挂载到 Agent，提供 steer/abort/toolBlock 函数 */
  attach(api: {
    steer?: (message: string) => void;
    abort?: (reason: string) => void;
    toolBlock?: (toolName: string, args: unknown) => boolean; // 返回 true 表示阻止
  }): void {
    this.steerFn = api.steer || null;
    this.abortFn = api.abort || null;
    this.toolBlockFn = api.toolBlock || null;
    this.attached = true;
  }

  /** 事件监听 */
  on(listener: (event: ProgressGuardEvent) => void): () => void {
    this.eventListeners.push(listener);
    return () => {
      const idx = this.eventListeners.indexOf(listener);
      if (idx >= 0) this.eventListeners.splice(idx, 1);
    };
  }

  /** 开始新 turn */
  startTurn(): void {
    this.currentTurn++;
    this.collector.startTurn();
  }

  /** 记录助手文本输出 */
  recordAssistantOutput(text: string, tokensUsed?: number): void {
    if (!this.config.enabled) return;
    this.collector.recordAssistantOutput(text, tokensUsed);
    if (tokensUsed) {
      this.budget.tokens += tokensUsed;
      this.metrics.addTokens(tokensUsed);
    }
  }

  /** 记录工具调用并执行检测 */
  recordToolCall(
    toolName: string,
    args: Record<string, unknown>,
    result: { success: boolean; output?: string; error?: string; tokensUsed?: number },
  ): InterventionLevel | null {
    if (!this.config.enabled) return null;

    // 工具限制检查
    if (this.recoveryController.isToolRestricted(toolName)) {
      if (this.toolBlockFn) {
        this.toolBlockFn(toolName, args);
      }
      return 'tool_restriction';
    }

    // 获取状态快照
    const beforeSnapshot = this.stateEngine.getSnapshot();

    // 记录到采集器
    this.collector.recordToolCall(
      toolName,
      args,
      result,
      beforeSnapshot.stateHash,
      this.stateEngine.getSnapshot().stateHash,
    );

    // 更新状态引擎
    const step = this.collector.getRecentSteps(1)[0];
    if (step) {
      this.stateEngine.update(
        step.toolIntent || 'OTHER',
        step.resourceType || 'other',
        step.resourceId,
        step.outputHash || '',
        step.errorHash,
      );
    }

    // 更新预算
    this.budget.toolCalls++;
    if (result.tokensUsed) {
      this.budget.tokens += result.tokensUsed;
      this.metrics.addTokens(result.tokensUsed);
    }

    // 执行检测（最小 turn 数之后）
    if (this.currentTurn >= this.config.minTurnsBeforeDetect) {
      return this.runDetection();
    }

    return null;
  }

  /** 执行检测流程 */
  private runDetection(): InterventionLevel | null {
    const steps = this.collector.getTrace().steps;

    // 1. 计算进展评分
    const progressScore = computeProgressScore(steps, this.previousProgressScore);
    this.previousProgressScore = progressScore.score;
    this.metrics.updateProgress(progressScore.score);

    // 2. P3 语义分析
    if (this.config.semantic.enabled && this.config.strategies.includes('semantic')) {
      const semanticResult = this.semanticAnalyzer.detect(steps);
      // 语义结果会被 risk engine 间接使用
    }

    // 3. 风险评估
    const assessment = this.riskEngine.assess(steps, progressScore, this.budget);
    this.metrics.updateRisk(assessment.score, assessment.level);

    // 4. 冷却期检查
    if (this.recoveryController.isInCooldown(this.currentTurn)) {
      return null;
    }

    // 5. 恢复控制
    const intervention = this.recoveryController.process(assessment, this.currentTurn);

    // 6. Dashboard 历史
    if (this.config.dashboard.enabled) {
      this.dashboardHistory.push({
        turn: this.currentTurn,
        riskScore: assessment.score,
        progressScore: progressScore.score,
        level: assessment.level,
      });
      if (this.dashboardHistory.length > this.config.dashboard.historySize) {
        this.dashboardHistory = this.dashboardHistory.slice(-this.config.dashboard.historySize);
      }
    }

    // 7. 执行干预
    if (intervention) {
      this.metrics.addIntervention();
      return this.executeIntervention(intervention);
    }

    // 8. P3 自适应权重更新
    if (this.config.adaptiveWeights.enabled) {
      const allStrategies: StrategyName[] = ['state_freeze', 'error_loop', 'tool_cycle', 'action_repeat', 'progress_stagnation', 'budget_waste', 'semantic'];
      const features = {} as Record<StrategyName, number>;
      for (const s of allStrategies) {
        features[s] = 0;
      }
      for (const e of assessment.evidence) {
        features[e.strategy] = e.confidence;
      }
      this.adaptiveWeights.record(
        this.currentTurn,
        features,
        assessment.level !== 'normal',
        this.recoveryController.level === 'normal',
      );

      // 应用学到的权重
      const learnedWeights = this.adaptiveWeights.getWeights();
      this.riskEngine.updateWeights(learnedWeights);
    }

    // 发布进展事件
    this.emitEvent({
      type: 'progress_update',
      score: progressScore.score,
      trend: progressScore.trend,
      turn: this.currentTurn,
    });

    return null;
  }

  /** 执行干预动作 */
  private executeIntervention(event: import('./types').InterventionEvent): InterventionLevel {
    switch (event.action) {
      case 'reflection':
        // 注入反思消息
        if (this.steerFn && event.message) {
          this.steerFn(event.message);
        }
        this.emitEvent({
          type: 'intervention',
          level: event.level,
          action: 'reflection',
          message: event.message,
        });
        break;

      case 'context_reset':
        // 注入上下文重置消息
        if (this.steerFn && event.message) {
          this.steerFn(event.message);
        }
        this.emitEvent({
          type: 'intervention',
          level: event.level,
          action: 'context_reset',
          message: event.message,
        });
        break;

      case 'tool_restriction':
        // 限制导致循环的工具
        const trace = this.collector.getTrace();
        const lastTool = trace.steps.filter(s => s.type === 'tool_call').slice(-1)[0];
        if (lastTool?.toolName) {
          this.recoveryController.restrictTool(lastTool.toolName);
          if (this.steerFn) {
            this.steerFn(`[系统提示] 工具 ${lastTool.toolName} 已被暂时限制，请使用其他方法。`);
          }
        }
        this.emitEvent({
          type: 'intervention',
          level: event.level,
          action: 'tool_restriction',
        });
        break;

      case 'terminate':
        // 终止运行
        if (this.abortFn) {
          const report = this.recoveryController.createFailureReport(
            this.riskEngine.assess(this.collector.getTrace().steps, { score: this.previousProgressScore, trend: 'flat', signals: { stateChange: 0, infoGain: 0, errorMovement: 0, novelty: 0, outputGrowth: 0 } }, this.budget),
            this.stateEngine,
            this.budget.tokens,
          );
          this.abortFn(JSON.stringify(report));
        }
        this.emitEvent({
          type: 'intervention',
          level: 'failed',
          action: 'terminate',
        });
        break;
    }

    return event.action;
  }

  /** 是否应该阻止工具调用 */
  shouldBlockTool(toolName: string, args: unknown): boolean {
    if (!this.config.enabled) return false;
    return this.recoveryController.isToolRestricted(toolName);
  }

  // ─── 查询 API ───

  /** 获取当前风险等级 */
  get riskLevel(): RiskLevel {
    return this.recoveryController.level;
  }

  /** 获取当前指标快照 */
  getMetrics(): import('./types').MetricsSnapshot {
    return this.metrics.snapshot();
  }

  /** 获取 Dashboard 数据 (P3) */
  getDashboardData() {
    return {
      history: [...this.dashboardHistory],
      currentLevel: this.recoveryController.level,
      currentWeights: this.riskEngine.getWeights(),
      adaptiveWeights: this.adaptiveWeights.getWeights(),
      metrics: this.metrics.snapshot(),
    };
  }

  /** 获取诊断报告 */
  getDiagnosis(): ProgressDiagnosis {
    const steps = this.collector.getTrace().steps;
    const assessment = this.riskEngine.assess(
      steps,
      { score: this.previousProgressScore, trend: 'flat', signals: { stateChange: 0, infoGain: 0, errorMovement: 0, novelty: 0, outputGrowth: 0 } },
      this.budget,
    );
    const recoveryState = this.recoveryController.getState();

    return {
      riskLevel: assessment.level,
      riskScore: assessment.score,
      firstDetectedTurn: recoveryState.firstDetectedTurn,
      stuckDurationTurns: assessment.consecutiveTurns,
      tokensWasted: this.metrics.snapshot().tokensWastedTotal,
      strategyBreakdown: assessment.evidence,
      progressTrend: this.riskEngine.getProgressHistory().map((score, i) => ({ turn: i, score })),
      detectedPatterns: assessment.reasons,
      whitelistChecks: [],
      suggestedAction: this.getSuggestedAction(assessment.level),
    };
  }

  /** 是否已启用 */
  get isEnabled(): boolean {
    return this.config.enabled;
  }

  /** 是否已挂载 */
  get isAttached(): boolean {
    return this.attached;
  }

  /** 当前 turn */
  get turn(): number {
    return this.currentTurn;
  }

  // ─── 内部方法 ───

  private emitEvent(event: ProgressGuardEvent): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch {
        // 忽略事件监听器错误
      }
    }
  }

  private getSuggestedAction(level: RiskLevel): string {
    switch (level) {
      case 'suspicious': return 'Agent 可能在原地打转，已注入反思提示。';
      case 'stuck': return 'Agent 已卡住，尝试重置上下文或限制工具。';
      case 'failed': return 'Agent 陷入循环，已终止运行。请调整任务描述。';
      default: return 'Agent 运行正常。';
    }
  }

  private createInitialBudget(): BudgetState {
    return {
      tokens: 0,
      cost: 0,
      toolCalls: 0,
      turns: 0,
      durationMs: 0,
      maxTokens: this.config.budget.maxTokens,
      maxToolCalls: this.config.budget.maxToolCalls,
      maxTurns: this.config.budget.maxTurns,
    };
  }

  /** 重置所有状态 */
  reset(): void {
    this.collector.reset();
    this.stateEngine.reset();
    this.riskEngine.reset();
    this.recoveryController.reset();
    this.metrics.reset();
    this.adaptiveWeights.reset();
    this.semanticAnalyzer.reset();
    this.currentTurn = 0;
    this.previousProgressScore = 0.5;
    this.budget = this.createInitialBudget();
    this.dashboardHistory = [];
  }
}

// Re-export types
export * from './types';
