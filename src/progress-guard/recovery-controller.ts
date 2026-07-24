/**
 * Recovery Controller — 状态机 + 分级干预 + 降级恢复
 */

import type {
  RiskLevel,
  RiskAssessment,
  RecoveryState,
  InterventionLevel,
  InterventionEvent,
  ProgressGuardConfig,
  FailureReport,
  StrategyName,
} from './types';
import type { StateEngine } from './state-engine';

/** 反思消息模板 */
const REFLECTION_MESSAGE = `你似乎在重复类似的操作但没有明显进展。请先停下来反思：

1. 你已经尝试了哪些方法？
2. 目前的状态和开始时有什么不同？
3. 是否需要换一种思路？
4. 如果卡住了，请直接说明，我可以提供帮助。

建议：先列一个清晰的下一步计划，再继续执行。`;

export class RecoveryController {
  private config: ProgressGuardConfig;
  private state: RecoveryState;
  private eventListeners: ((event: InterventionEvent) => void)[] = [];

  constructor(config: ProgressGuardConfig) {
    this.config = config;
    this.state = this.createInitialState();
  }

  private createInitialState(): RecoveryState {
    return {
      currentLevel: 'normal',
      currentIntervention: 'none',
      consecutiveHighRiskTurns: 0,
      consecutiveLowRiskTurns: 0,
      firstDetectedTurn: 0,
      interventionCount: 0,
      lastInterventionTurn: 0,
      stuckRetries: 0,
      restrictedTools: new Set(),
    };
  }

  /** 处理风险评估结果，返回干预动作 */
  process(assessment: RiskAssessment, currentTurn: number): InterventionEvent | null {
    const { confirmationTurns, downgradeTurns } = this.config.stateMachine;

    // ─── 升级逻辑 ───

    if (assessment.level !== 'normal' && assessment.level !== this.state.currentLevel) {
      // 风险超过当前等级
      if (this.isHigherLevel(assessment.level, this.state.currentLevel)) {
        this.state.consecutiveHighRiskTurns++;
        this.state.consecutiveLowRiskTurns = 0;

        if (this.state.firstDetectedTurn === 0) {
          this.state.firstDetectedTurn = currentTurn;
        }

        // 需要连续 confirmationTurns 轮确认才升级
        if (this.state.consecutiveHighRiskTurns >= confirmationTurns) {
          return this.upgrade(assessment, currentTurn);
        }
      }
    } else if (assessment.level === 'normal') {
      // ─── 降级逻辑 ───
      this.state.consecutiveLowRiskTurns++;
      this.state.consecutiveHighRiskTurns = 0;

      // 需要连续 downgradeTurns 轮恢复才降级
      if (this.state.consecutiveLowRiskTurns >= downgradeTurns && this.state.currentLevel !== 'normal') {
        return this.downgrade(currentTurn);
      }
    }

    return null;
  }

  /** 升级风险等级 */
  private upgrade(assessment: RiskAssessment, currentTurn: number): InterventionEvent {
    const previousLevel = this.state.currentLevel;
    this.state.currentLevel = assessment.level;
    this.state.consecutiveHighRiskTurns = 0;
    this.state.interventionCount++;
    this.state.lastInterventionTurn = currentTurn;

    let action: InterventionLevel;
    let message: string | undefined;

    switch (assessment.level) {
      case 'suspicious':
        action = 'reflection';
        message = REFLECTION_MESSAGE;
        break;

      case 'stuck':
        // 先尝试 context_reset，再尝试 tool_restriction
        if (this.state.stuckRetries < this.config.recovery.stuck.maxRetries) {
          const stuckActions = this.config.recovery.stuck.actions;
          action = stuckActions[Math.min(this.state.stuckRetries, stuckActions.length - 1)];
          this.state.stuckRetries++;
          message = this.buildContextResetMessage();
        } else {
          // 重试次数用完，升级到 failed
          action = 'terminate';
          this.state.currentLevel = 'failed';
        }
        break;

      case 'failed':
        action = 'terminate';
        break;

      default:
        action = 'none';
    }

    this.state.currentIntervention = action;

    const event: InterventionEvent = {
      level: this.state.currentLevel,
      action,
      message,
      timestamp: Date.now(),
    };

    this.notifyListeners(event);
    return event;
  }

  /** 降级风险等级 */
  private downgrade(currentTurn: number): InterventionEvent {
    const previousLevel = this.state.currentLevel;
    this.state.consecutiveLowRiskTurns = 0;

    // 降一级
    const levelOrder: RiskLevel[] = ['normal', 'suspicious', 'stuck', 'failed'];
    const currentIndex = levelOrder.indexOf(this.state.currentLevel);
    this.state.currentLevel = levelOrder[Math.max(0, currentIndex - 1)];
    this.state.currentIntervention = 'none';

    // 如果回到 normal，重置一些状态
    if (this.state.currentLevel === 'normal') {
      this.state.firstDetectedTurn = 0;
      this.state.stuckRetries = 0;
    }

    const event: InterventionEvent = {
      level: this.state.currentLevel,
      action: 'none',
      timestamp: Date.now(),
    };

    this.notifyListeners(event);
    return event;
  }

  /** 构建上下文重置消息 */
  private buildContextResetMessage(): string {
    // 简化版，P2 阶段再接入 transformContext
    return `[系统重置] 检测到你可能卡住了。请换一种方法重新开始，不要重复之前已经失败的尝试。

建议策略：
1. 回顾目标，确认当前进展
2. 分析卡住的原因
3. 尝试完全不同的方法
4. 如果需要，请求用户帮助`;
  }

  /** 添加工具限制 */
  restrictTool(toolName: string): void {
    this.state.restrictedTools.add(toolName);
  }

  /** 检查工具是否被限制 */
  isToolRestricted(toolName: string): boolean {
    return this.state.restrictedTools.has(toolName);
  }

  /** 清除工具限制 */
  clearRestrictions(): void {
    this.state.restrictedTools.clear();
  }

  /** 生成失败报告 */
  createFailureReport(assessment: RiskAssessment, stateEngine: StateEngine, tokensWasted: number): FailureReport {
    return {
      reason: assessment.reasons.join('; '),
      riskLevel: 'failed',
      diagnosis: {
        firstDetectedTurn: this.state.firstDetectedTurn,
        stuckDurationTurns: this.state.interventionCount,
        tokensWasted,
        patterns: assessment.evidence.map(e => e.detail),
        strategyBreakdown: assessment.evidence,
      },
      stateSnapshot: {
        modifiedResources: stateEngine.getModifiedResourceIds(),
        lastError: stateEngine.getRecentErrors(1)[0],
      },
      suggestion: 'Agent 陷入循环无法继续。请尝试重新描述任务或提供更多上下文。',
    };
  }

  /** 比较风险等级高低 */
  private isHigherLevel(a: RiskLevel, b: RiskLevel): boolean {
    const order: Record<RiskLevel, number> = { normal: 0, suspicious: 1, stuck: 2, failed: 3 };
    return order[a] > order[b];
  }

  /** 事件监听 */
  onIntervention(listener: (event: InterventionEvent) => void): void {
    this.eventListeners.push(listener);
  }

  private notifyListeners(event: InterventionEvent): void {
    for (const listener of this.eventListeners) {
      listener(event);
    }
  }

  /** 获取当前状态 */
  getState(): RecoveryState {
    return { ...this.state, restrictedTools: new Set(this.state.restrictedTools) };
  }

  /** 获取当前风险等级 */
  get level(): RiskLevel {
    return this.state.currentLevel;
  }

  /** 是否处于冷却期 */
  isInCooldown(currentTurn: number): boolean {
    if (this.config.recovery.suspicious.cooldownTurns <= 0) return false;
    return (currentTurn - this.state.lastInterventionTurn) < this.config.recovery.suspicious.cooldownTurns;
  }

  /** 重置 */
  reset(): void {
    this.state = this.createInitialState();
  }
}
