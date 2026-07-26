/**
 * ACR 指标 - 可观测性
 *
 * 功能：
 * - 记录压缩历史和统计数据
 * - 跟踪 token 节省量、压缩比例、执行耗时
 * - 按压缩级别统计次数
 * - 记录健康检查历史
 * - 提供指标快照供外部查看
 */

import type { CompressionLevel, CompressionResult } from '../types';

/** 压缩记录 - 单次压缩的详细数据 */
export interface CompressionRecord {
  id: string;                 // 记录 ID
  timestamp: number;          // 时间戳
  level: CompressionLevel;    // 压缩级别
  trigger: string;            // 触发原因
  tokensBefore: number;       // 压缩前 token 数
  tokensAfter: number;        // 压缩后 token 数
  tokensSaved: number;        // 节省的 token 数
  compressionRatio: number;   // 压缩比例 (0-1)
  messagesBefore: number;     // 压缩前消息数
  messagesAfter: number;      // 压缩后消息数
  durationMs: number;         // 执行耗时（毫秒）
  stateVersion: number;       // 状态版本号
  strategiesUsed: string[];   // 使用的策略列表
}

/** 指标快照 - 当前所有指标的汇总 */
export interface MetricsSnapshot {
  compressionsTotal: number;         // 总压缩次数
  tokensSavedTotal: number;          // 总节省 token 数
  avgCompressionRatio: number;       // 平均压缩比例
  avgDurationMs: number;             // 平均耗时
  currentStateVersion: number;       // 当前状态版本
  compressionsByLevel: Record<CompressionLevel, number>;  // 各级别压缩次数
  toolDigestsCreated: number;        // 生成的工具摘要数
  pairingFixes: number;              // 工具配对修复次数
  healthHistory: Array<{             // 健康检查历史
    timestamp: number;
    level: string;
    tokens: number;
    density: number;
  }>;
}

/**
 * 指标收集器类
 * 收集和统计 ACR 的运行数据
 */
export class Metrics {
  private compressions: CompressionRecord[] = [];     // 压缩记录历史
  private compressionsTotal = 0;                       // 总压缩次数
  private tokensSavedTotal = 0;                        // 总节省 token
  private totalRatio = 0;                              // 压缩比例总和（用于计算平均）
  private totalDuration = 0;                           // 总耗时（用于计算平均）
  // 各级别压缩次数
  private compressionsByLevel: Record<CompressionLevel, number> = {
    clean: 0,
    window: 0,
    collapse: 0,
    snapshot: 0,
    emergency: 0,
  };
  private toolDigestsCreated = 0;   // 工具摘要生成数
  private pairingFixes = 0;         // 配对修复数
  private stateVersion = 1;         // 状态版本
  private healthHistory: Array<{ timestamp: number; level: string; tokens: number; density: number }> = [];
  private maxHistorySize: number;   // 最大历史记录数

  constructor(maxHistorySize: number = 20) {
    this.maxHistorySize = maxHistorySize;
  }

  /**
   * 记录一次压缩
   */
  recordCompression(result: CompressionResult): void {
    const record: CompressionRecord = {
      id: `acr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
      level: result.level,
      trigger: result.trigger,
      tokensBefore: result.tokensBefore,
      tokensAfter: result.tokensAfter,
      tokensSaved: result.tokensSaved,
      compressionRatio: result.compressionRatio,
      messagesBefore: result.messagesBefore,
      messagesAfter: result.messagesAfter,
      durationMs: result.durationMs,
      stateVersion: result.stateVersion,
      strategiesUsed: result.strategiesUsed,
    };

    this.compressions.push(record);
    if (this.compressions.length > this.maxHistorySize) {
      this.compressions.shift();
    }

    this.compressionsTotal++;
    this.tokensSavedTotal += result.tokensSaved;
    this.totalRatio += result.compressionRatio;
    this.totalDuration += result.durationMs;
    this.compressionsByLevel[result.level]++;
    this.stateVersion = result.stateVersion;

    if (result.toolDigestsCreated) {
      this.toolDigestsCreated += result.toolDigestsCreated;
    }
  }

  /**
   * 记录工具配对修复次数
   */
  recordPairingFixes(count: number): void {
    this.pairingFixes += count;
  }

  /**
   * 记录一次工具摘要生成
   */
  recordToolDigest(): void {
    this.toolDigestsCreated++;
  }

  /**
   * 记录一次健康检查
   */
  recordHealthCheck(level: string, tokens: number, density: number = 1): void {
    this.healthHistory.push({
      timestamp: Date.now(),
      level,
      tokens,
      density,
    });
    if (this.healthHistory.length > this.maxHistorySize) {
      this.healthHistory.shift();
    }
  }

  /**
   * 更新状态版本号
   */
  updateStateVersion(version: number): void {
    this.stateVersion = version;
  }

  /**
   * 获取指标快照
   */
  snapshot(): MetricsSnapshot {
    return {
      compressionsTotal: this.compressionsTotal,
      tokensSavedTotal: this.tokensSavedTotal,
      avgCompressionRatio: this.compressionsTotal > 0 ? this.totalRatio / this.compressionsTotal : 0,
      avgDurationMs: this.compressionsTotal > 0 ? this.totalDuration / this.compressionsTotal : 0,
      currentStateVersion: this.stateVersion,
      compressionsByLevel: { ...this.compressionsByLevel },
      toolDigestsCreated: this.toolDigestsCreated,
      pairingFixes: this.pairingFixes,
      healthHistory: [...this.healthHistory],
    };
  }

  /**
   * 获取最近 N 次压缩记录
   */
  getRecentCompressions(count: number = 5): CompressionRecord[] {
    return this.compressions.slice(-count);
  }

  /**
   * 获取最近一次压缩记录
   */
  getLastCompression(): CompressionRecord | null {
    return this.compressions.length > 0 ? this.compressions[this.compressions.length - 1] : null;
  }

  /**
   * 重置所有指标
   */
  reset(): void {
    this.compressions = [];
    this.compressionsTotal = 0;
    this.tokensSavedTotal = 0;
    this.totalRatio = 0;
    this.totalDuration = 0;
    this.compressionsByLevel = {
      clean: 0,
      window: 0,
      collapse: 0,
      snapshot: 0,
      emergency: 0,
    };
    this.toolDigestsCreated = 0;
    this.pairingFixes = 0;
    this.stateVersion = 1;
    this.healthHistory = [];
  }
}
