/**
 * Token 监控器 - 跟踪 token 使用情况并触发压缩
 *
 * 功能：
 * - 估算消息列表的 token 数量
 * - 检查 token 健康状态（ok/attention/warning/critical/emergency/fatal）
 * - 根据健康级别决定需要的压缩级别
 * - 提供滞回判断，避免频繁压缩
 */

import type { AgentMessage } from '../../agent';
import type { TokenHealth, TokenMonitorConfig, HealthLevel } from '../types';
import { estimateMessageTokens } from '../state/message-adapter';

/**
 * Token 监控器类
 * 负责跟踪 token 使用量并判断是否需要压缩
 */
export class TokenMonitor {
  private config: TokenMonitorConfig;   // 监控配置
  private contextLimit: number;         // 上下文 token 上限

  constructor(contextLimit: number, config: TokenMonitorConfig) {
    this.contextLimit = contextLimit;
    this.config = config;
  }

  /**
   * 估算消息列表的 token 数量（简单近似）
   * 每条消息增加 10 个 token 的开销
   */
  estimateTokens(messages: AgentMessage[]): number {
    let total = 0;
    for (const msg of messages) {
      total += estimateMessageTokens(msg);
      // 消息开销
      total += 10;
    }
    return total;
  }

  /**
   * 检查 token 健康状态
   * 根据使用比例返回对应的健康级别
   */
  check(usedTokens: number): TokenHealth {
    const ratio = usedTokens / this.contextLimit;
    let level: HealthLevel = 'ok';

    if (ratio >= this.config.fatal) {
      level = 'fatal';        // 致命 - 已超出上限
    } else if (ratio >= this.config.emergency) {
      level = 'emergency';    // 紧急 - 接近上限
    } else if (ratio >= this.config.critical) {
      level = 'critical';     // 严重 - 需要主动压缩
    } else if (ratio >= this.config.warning) {
      level = 'warning';      // 警告 - 可做轻度清理
    } else if (ratio >= this.config.attention) {
      level = 'attention';    // 注意 - 持续关注中
    }

    return {
      used: usedTokens,
      limit: this.contextLimit,
      ratio,
      level,
    };
  }

  /**
   * 根据 token 健康状态确定需要的压缩级别
   *
   * 级别映射：
   * - warning  → clean (L1 无损清理)
   * - critical → window (L2 窗口化)
   * - emergency → collapse (L3 折叠)
   * - fatal → snapshot (L4 快照重写，如不够会由 postCheck 升到 L5)
   */
  getRequiredCompressionLevel(health: TokenHealth): 'clean' | 'window' | 'collapse' | 'snapshot' | 'emergency' | null {
    switch (health.level) {
      case 'warning':
        return 'clean';
      case 'critical':
        return 'window';
      case 'emergency':
        return 'collapse';
      case 'fatal':
        return 'snapshot';
      default:
        return null;
    }
  }

  /**
   * 判断是否需要压缩（用于滞回控制）
   * 只有达到 warning 及以上才触发压缩
   */
  shouldCompress(health: TokenHealth): boolean {
    return health.level !== 'ok' && health.level !== 'attention';
  }
}
