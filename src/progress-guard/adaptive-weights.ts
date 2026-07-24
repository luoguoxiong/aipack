/**
 * Adaptive Weights — P3 自适应权重学习
 * 根据历史反馈自动调整各策略的权重
 */

import type { StrategyName, AdaptiveWeightState, ProgressGuardConfig } from './types';

export class AdaptiveWeights {
  private state: AdaptiveWeightState;
  private config: ProgressGuardConfig['adaptiveWeights'];
  private strategyNames: StrategyName[];

  constructor(config: ProgressGuardConfig) {
    this.config = config.adaptiveWeights;
    this.strategyNames = config.strategies;
    this.state = {
      weights: { ...config.strategyWeights },
      history: [],
    };
  }

  /** 记录一轮的结果，用于学习 */
  record(
    turn: number,
    features: Record<StrategyName, number>,
    wasLoop: boolean,
    interventionWorked: boolean,
  ): void {
    if (!this.config.enabled) return;

    this.state.history.push({ turn, features, wasLoop, interventionWorked });
    if (this.state.history.length > this.config.historySize) {
      this.state.history = this.state.history.slice(-this.config.historySize);
    }

    this.learn();
  }

  /** 在线学习：调整权重 */
  private learn(): void {
    const recent = this.state.history.slice(-20);
    if (recent.length < 5) return;

    const lr = this.config.learningRate;

    for (const name of this.strategyNames) {
      // 统计该策略对循环的预测准确率
      let truePositive = 0;
      let falsePositive = 0;
      let falseNegative = 0;

      for (const entry of recent) {
        const feature = entry.features[name] || 0;
        const predicted = feature > 0.5;

        if (predicted && entry.wasLoop) truePositive++;
        if (predicted && !entry.wasLoop) falsePositive++;
        if (!predicted && entry.wasLoop) falseNegative++;
      }

      // 如果误报多，降低权重；如果漏报多，提高权重
      const precision = truePositive / (truePositive + falsePositive + 1);
      const recall = truePositive / (truePositive + falseNegative + 1);

      // 偏向 recall（减少漏报），同时惩罚低 precision（减少误报）
      const adjustment = lr * (recall - 0.5 * (1 - precision));

      this.state.weights[name] = Math.max(0.05, Math.min(0.6,
        this.state.weights[name] + adjustment,
      ));
    }

    // 归一化权重，使总和 = 1
    const sum = this.strategyNames.reduce((s, n) => s + (this.state.weights[n] || 0), 0);
    if (sum > 0) {
      for (const name of this.strategyNames) {
        this.state.weights[name] = (this.state.weights[name] || 0) / sum;
      }
    }
  }

  /** 获取当前权重 */
  getWeights(): Record<StrategyName, number> {
    return { ...this.state.weights };
  }

  /** 获取学习状态 */
  getState(): AdaptiveWeightState {
    return { ...this.state, history: [...this.state.history] };
  }

  /** 重置 */
  reset(): void {
    this.state = {
      weights: { ...this.state.weights },
      history: [],
    };
  }
}
