/**
 * Metrics — 指标采集
 */

import type { RiskLevel, MetricsSnapshot } from './types';

export class Metrics {
  private riskScore = 0;
  private riskLevel: RiskLevel = 'normal';
  private progressScore = 0;
  private tokensTotal = 0;
  private interventionTotal = 0;
  private detectedTotal = 0;
  private tokensWastedTotal = 0;
  private whitelistHitsTotal = 0;
  private recoveryTurns: number[] = [];

  updateRisk(score: number, level: RiskLevel): void {
    this.riskScore = score;
    this.riskLevel = level;
  }

  updateProgress(score: number): void {
    this.progressScore = score;
  }

  addTokens(n: number): void {
    this.tokensTotal += n;
  }

  addIntervention(): void {
    this.interventionTotal++;
  }

  addDetection(): void {
    this.detectedTotal++;
  }

  addTokensWasted(n: number): void {
    this.tokensWastedTotal += n;
  }

  addWhitelistHit(): void {
    this.whitelistHitsTotal++;
  }

  addRecoveryTurns(turns: number): void {
    this.recoveryTurns.push(turns);
    if (this.recoveryTurns.length > 100) {
      this.recoveryTurns = this.recoveryTurns.slice(-100);
    }
  }

  snapshot(): MetricsSnapshot {
    return {
      riskScore: this.riskScore,
      riskLevel: this.riskLevel,
      progressScore: this.progressScore,
      tokensTotal: this.tokensTotal,
      interventionTotal: this.interventionTotal,
      detectedTotal: this.detectedTotal,
      tokensWastedTotal: this.tokensWastedTotal,
      whitelistHitsTotal: this.whitelistHitsTotal,
      recoveryTurns: [...this.recoveryTurns],
    };
  }

  reset(): void {
    this.riskScore = 0;
    this.riskLevel = 'normal';
    this.progressScore = 0;
    this.tokensTotal = 0;
    this.interventionTotal = 0;
    this.detectedTotal = 0;
    this.tokensWastedTotal = 0;
    this.whitelistHitsTotal = 0;
    this.recoveryTurns = [];
  }
}
