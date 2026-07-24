/**
 * Risk Engine — 风险评估 + 白名单过滤
 */

import type {
  TraceStep,
  RiskLevel,
  RiskAssessment,
  StrategyName,
  AgentProfile,
  WhitelistConfig,
  WhitelistCheckResult,
  BudgetState,
  ProgressScore,
} from './types';
import type { ProgressGuardConfig } from './types';
import {
  detectStateFreeze,
  detectErrorLoop,
  detectToolCycle,
  detectActionRepeat,
  detectProgressStagnation,
  detectBudgetWaste,
} from './progress-analyzer';

// ─── Profile 预设 ───

const PROFILE_WEIGHTS: Record<AgentProfile, Partial<Record<StrategyName, number>>> = {
  coding: {
    state_freeze: 0.40,
    error_loop: 0.35,
    tool_cycle: 0.10,
  },
  research: {
    tool_cycle: 0.25,
    state_freeze: 0.15,
    progress_stagnation: 0.20,
  },
  assistant: {
    action_repeat: 0.20,
    progress_stagnation: 0.25,
    state_freeze: 0.10,
  },
  workflow: {
    budget_waste: 0.20,
    progress_stagnation: 0.20,
  },
};

export class RiskEngine {
  private config: ProgressGuardConfig;
  private weights: Record<StrategyName, number>;
  private progressHistory: number[] = [];

  constructor(config: ProgressGuardConfig) {
    this.config = config;
    this.weights = { ...config.strategyWeights };

    // 应用 Profile 覆盖
    const profileOverrides = PROFILE_WEIGHTS[config.profile];
    if (profileOverrides) {
      for (const [key, value] of Object.entries(profileOverrides)) {
        if (value !== undefined) {
          this.weights[key as StrategyName] = value;
        }
      }
    }
  }

  /** 评估风险 */
  assess(
    steps: TraceStep[],
    progressScore: ProgressScore,
    budget: BudgetState,
  ): RiskAssessment {
    this.progressHistory.push(progressScore.score);
    if (this.progressHistory.length > 50) {
      this.progressHistory = this.progressHistory.slice(-50);
    }

    // 运行所有启用的策略
    const results: { name: StrategyName; result: ReturnType<typeof detectStateFreeze> }[] = [];

    if (this.config.strategies.includes('state_freeze')) {
      results.push({ name: 'state_freeze', result: detectStateFreeze(steps) });
    }
    if (this.config.strategies.includes('error_loop')) {
      results.push({ name: 'error_loop', result: detectErrorLoop(steps) });
    }
    if (this.config.strategies.includes('tool_cycle')) {
      results.push({ name: 'tool_cycle', result: detectToolCycle(steps) });
    }
    if (this.config.strategies.includes('action_repeat')) {
      results.push({ name: 'action_repeat', result: detectActionRepeat(steps) });
    }
    if (this.config.strategies.includes('progress_stagnation')) {
      results.push({ name: 'progress_stagnation', result: detectProgressStagnation(this.progressHistory) });
    }
    if (this.config.strategies.includes('budget_waste')) {
      results.push({ name: 'budget_waste', result: detectBudgetWaste(budget, progressScore.score, this.config.budget.efficiencyThreshold) });
    }

    // 加权融合
    let riskScore = 0;
    const reasons: string[] = [];
    const evidence: RiskAssessment['evidence'] = [];

    for (const { name, result } of results) {
      if (result.detected) {
        const weight = this.weights[name] || 0;
        riskScore += result.confidence * weight;
        reasons.push(result.detail || `${name} detected`);
        evidence.push({
          strategy: name,
          confidence: result.confidence,
          detail: result.detail || '',
        });
      }
    }

    riskScore = Math.min(1, riskScore);

    // 白名单过滤
    const whitelistResult = this.checkWhitelist(steps, progressScore);
    if (whitelistResult.exempt) {
      riskScore *= 0.3; // 大幅降低风险分，但不完全忽略
      reasons.push(`白名单豁免: ${whitelistResult.reason}`);
    }

    const level = this.scoreToLevel(riskScore);

    return {
      level,
      score: riskScore,
      reasons,
      evidence,
      consecutiveTurns: 0, // 由 RecoveryController 维护
      firstDetectedTurn: 0, // 由 RecoveryController 维护
    };
  }

  /** 白名单检查 */
  checkWhitelist(steps: TraceStep[], progressScore: ProgressScore): WhitelistCheckResult {
    const wl = this.config.whitelist;
    const recent = steps.slice(-5);

    // 批量操作模式
    if (wl.batchOperation) {
      const resourceIds = recent.filter(s => s.resourceId).map(s => s.resourceId);
      const uniqueIds = new Set(resourceIds);
      if (uniqueIds.size >= 3 && recent.some(s => s.stateChanged)) {
        return { exempt: true, reason: '批量操作模式（枚举不同资源）', matchedRule: 'batch_operation' };
      }
    }

    // 长思考链模式
    if (wl.longThinkingChain) {
      const toolCalls = recent.filter(s => s.type === 'tool_call').length;
      const textSteps = recent.filter(s => s.textLength && s.textLength > 0);
      if (toolCalls <= 2 && textSteps.length >= 2) {
        const lengths = textSteps.map(s => s.textLength!);
        const isGrowing = lengths.every((l, i) => i === 0 || l > lengths[i - 1] * 0.8);
        if (isGrowing) {
          return { exempt: true, reason: '长思考链模式（文本输出持续增长）', matchedRule: 'long_thinking_chain' };
        }
      }
    }

    // 自我修正模式
    if (wl.selfCorrectionRetries > 0) {
      const errorSteps = recent.filter(s => !s.success && s.errorHash);
      if (errorSteps.length >= 2) {
        const errorHashes = errorSteps.map(s => s.errorHash!);
        const uniqueErrors = new Set(errorHashes);
        if (uniqueErrors.size === errorHashes.length && errorHashes.length <= wl.selfCorrectionRetries) {
          return { exempt: true, reason: '自我修正模式（错误在变化）', matchedRule: 'self_correction' };
        }
      }
    }

    // 允许重复的工具
    if (wl.allowedRepeatTools.length > 0) {
      const lastStep = recent[recent.length - 1];
      if (lastStep?.toolName && wl.allowedRepeatTools.includes(lastStep.toolName)) {
        return { exempt: true, reason: `工具 ${lastStep.toolName} 在白名单中`, matchedRule: 'allowed_tool' };
      }
    }

    return { exempt: false };
  }

  /** 风险分 → 等级 */
  scoreToLevel(score: number): RiskLevel {
    const { suspicious, stuck, failed } = this.config.thresholds;
    if (score >= failed) return 'failed';
    if (score >= stuck) return 'stuck';
    if (score >= suspicious) return 'suspicious';
    return 'normal';
  }

  /** 更新权重（P3 自适应） */
  updateWeights(newWeights: Partial<Record<StrategyName, number>>): void {
    for (const [key, value] of Object.entries(newWeights)) {
      if (value !== undefined) {
        this.weights[key as StrategyName] = value;
      }
    }
  }

  /** 获取当前权重 */
  getWeights(): Record<StrategyName, number> {
    return { ...this.weights };
  }

  /** 获取进展历史 */
  getProgressHistory(): number[] {
    return [...this.progressHistory];
  }

  /** 重置 */
  reset(): void {
    this.progressHistory = [];
  }
}
