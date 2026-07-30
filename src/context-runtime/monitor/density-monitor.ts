/**
 * 价值密度监控器 - 主动检测低价值上下文
 *
 * 功能：
 * - 评估消息列表的价值密度（高价值 token 占比）
 * - 检测重复工具输出、冗余读取、空输出、长临时输出等信号
 * - 当密度低于阈值时主动触发压缩
 *
 * 设计思路：
 * 不是等 token 满了才压缩，而是主动发现上下文"水"了就压缩，
 * 保持上下文的信息浓度。
 */

import type { AgentMessage } from '../../agent';
import type { ValueDensity, ValueDensityConfig } from '../types';
import { getMessageContent, estimateMessageTokens, isCustomMessage } from '../state/message-adapter';

/**
 * 价值密度监控器类
 * 通过多维度信号评估上下文的信息密度
 */
export class DensityMonitor {
  private config: ValueDensityConfig;              // 配置
  private contextLimit: number;                     // 上下文上限
  private seenOutputHashes = new Map<string, number>();  // 输出哈希计数（用于去重检测）
  private readFileHistory = new Map<string, { contentHash: string; count: number }>();  // 文件读取历史

  constructor(contextLimit: number, config: ValueDensityConfig) {
    this.contextLimit = contextLimit;
    this.config = config;
  }

  /**
   * 检查消息的价值密度
   *
   * @param messages 消息列表
   * @param currentTokens 当前 token 数
   * @returns 密度值和检测到的信号
   */
  check(messages: AgentMessage[], currentTokens: number): ValueDensity {
    // 只有达到一定 token 量才检查（避免早期就触发）
    if (currentTokens < this.contextLimit * this.config.minTokensToCheck) {
      return {
        density: 1.0,
        signals: {
          duplicateToolResults: 0,
          redundantReads: 0,
          emptyOrTrivialOutputs: 0,
          staleErrors: 0,
          longTemporaryOutputs: 0,
        },
      };
    }

    // 初始化各种低价值信号计数器
    const signals = {
      duplicateToolResults: 0,    // 重复的工具结果
      redundantReads: 0,          // 冗余的文件读取
      emptyOrTrivialOutputs: 0,   // 空或无意义输出
      staleErrors: 0,             // 陈旧的错误
      longTemporaryOutputs: 0,    // 长临时输出（日志等）
    };

    let highValueTokens = 0;  // 高价值 token 数
    let totalTokens = 0;      // 总 token 数

    this.seenOutputHashes.clear();

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const content = getMessageContent(msg);
      const msgTokens = estimateMessageTokens(msg) + 10;
      totalTokens += msgTokens;

      // 检查是否是高价值内容
      if (this.isHighValue(msg, content)) {
        highValueTokens += msgTokens;
        continue;
      }

      // 检测重复工具结果
      if (msg.role === 'toolResult' && content) {
        const hash = this.hashContent(content.slice(0, 1000));
        const existing = this.seenOutputHashes.get(hash);
        if (existing) {
          signals.duplicateToolResults++;
          this.seenOutputHashes.set(hash, existing + 1);
        } else {
          this.seenOutputHashes.set(hash, 1);
        }
      }

      // 检测空/无意义输出
      if (content.trim().length < 20 || content.trim().match(/^(ok|done|success|完成|好的)[.!]*$/i)) {
        signals.emptyOrTrivialOutputs++;
      }

      // 检测长临时输出（日志、长列表等）
      if (content.length > 2000 && this.isTemporaryOutput(content)) {
        signals.longTemporaryOutputs++;
      }

      // 检测冗余读取（同一文件多次读取且内容未变）
      // P0：简单启发式 - 检测工具结果中的重复内容
      if (msg.role === 'toolResult' && content) {
        const fileMatch = content.match(/(?:read_file|file):?\s*["']?([^"'\s]+)["']?/i);
        if (fileMatch) {
          const filePath = fileMatch[1];
          const contentHash = this.hashContent(content.slice(-500));
          const existing = this.readFileHistory.get(filePath);
          if (existing && existing.contentHash === contentHash) {
            signals.redundantReads++;
            this.readFileHistory.set(filePath, { contentHash, count: existing.count + 1 });
          } else {
            this.readFileHistory.set(filePath, { contentHash, count: 1 });
          }
        }
      }
    }

    // 计算密度（设置下限防止过低）
    // 惩罚因子：根据各种低价值信号降低密度评分
    const penaltyFactor = Math.max(0.3, 1 - (
      signals.duplicateToolResults * 0.1 +
      signals.redundantReads * 0.08 +
      signals.emptyOrTrivialOutputs * 0.05 +
      signals.longTemporaryOutputs * 0.15
    ) / messages.length);

    const baseDensity = totalTokens > 0 ? highValueTokens / totalTokens : 1.0;
    const density = Math.min(1.0, baseDensity * penaltyFactor);

    return { density, signals };
  }

  /**
   * 是否因密度过低需要触发压缩
   * 同时满足：密度低于阈值 + token 量足够大
   */
  shouldCompress(density: ValueDensity, currentTokens: number): boolean {
    return density.density < this.config.threshold &&
           currentTokens > this.contextLimit * this.config.minTokensToCheck;
  }

  /**
   * 判断消息是否是高价值内容
   * 高价值内容会被保留在上下文中
   */
  private isHighValue(msg: AgentMessage, content: string): boolean {
    // 用户消息通常是高价值的
    if (msg.role === 'user') return true;
    
    // 自定义消息（状态快照等）是高价值的，除非是我们自己的过渡消息
    if (isCustomMessage(msg) && !content.startsWith('[系统]')) return true;

    // 压缩摘要也是高价值的
    if (msg.role === 'compactionSummary') return true;

    // 包含高价值关键词的内容
    const highValuePatterns = [
      /不要|禁止|必须|一定要|需要|注意|constraint|must|should|do not/i,
      /error|Error|FAIL|失败|错误|bug|fix|issue/i,
      /目标|goal|objective|task|任务|要做/i,
      /决定|决策|decision|decided|chose/i,
      /成功|success|passed|fixed|resolved|完成/i,
    ];

    for (const pattern of highValuePatterns) {
      if (pattern.test(content)) {
        return true;
      }
    }

    return false;
  }

  /**
   * 判断是否是临时输出（日志、进度条等）
   * 这类内容信息密度低，可以安全压缩
   */
  private isTemporaryOutput(content: string): boolean {
    // 长日志、进度条等
    const tempPatterns = [
      /npm|yarn|pnpm.*(install|build|test)/,
      /npm warn|npm error|yarn add|vite|webpack|rollup/i,
      /pytest|unittest|jest|mocha.*\.\.\./,
      /progress|downloading|installing|building|compiling/i,
      /\s{20,}/, // 大量空白
      /^[\s\S]*(\[|\||\s*─+\s*)+[\s\S]*$/, // ASCII 表格/进度条
    ];

    let matchCount = 0;
    for (const pattern of tempPatterns) {
      if (pattern.test(content)) {
        matchCount++;
      }
    }
    return matchCount >= 2;  // 至少匹配 2 个模式才判定
  }

  /**
   * 简单内容哈希函数
   * 用于去重检测
   */
  private hashContent(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(36);
  }

  /**
   * 重置监控器状态
   */
  reset(): void {
    this.seenOutputHashes.clear();
    this.readFileHistory.clear();
  }
}
