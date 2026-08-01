/**
 * 快照构建器 - 基于 AgentState 重建上下文
 *
 * 根据压缩级别，用状态快照 + 最近消息 + 工具摘要
 * 重新构建一个新的上下文窗口。
 */

import type { AgentMessage } from '../../agent';
import type { AgentState, CompressionLevel, ToolDigest } from '../types';
import { formatStateSnapshot } from './agent-state';
import { RECENT_KEEP } from '../types';
import { createStateSnapshotMessage, createToolDigestMessage, createCompactionMessage } from './message-adapter';

/** 构建选项 */
export interface BuildOptions {
  level: CompressionLevel;      // 压缩级别
  systemPrompt: string;         // 系统提示词
  recentMessages: AgentMessage[];  // 最近消息
  toolDigests: ToolDigest[];    // 工具摘要
  transitionMessage?: string;   // 过渡消息
  state?: AgentState;           // Agent 状态
}

/**
 * 快照构建器类
 * 根据 AgentState 和压缩级别重建上下文
 */
export class SnapshotBuilder {
  /**
   * 从状态 + 最近消息构建新的上下文窗口
   *
   * 上下文结构：
   * L1: 状态快照
   * L2: （系统提示词 - 假设已在消息中）
   * L3: 最近消息
   * L4: 相关工具摘要（L2+ 级别）
   * L5: 过渡消息
   */
  build(options: BuildOptions): AgentMessage[] {
    const { level, systemPrompt, recentMessages, toolDigests, transitionMessage } = options;

    const result: AgentMessage[] = [];

    // L0: 系统提示词 - 注意：这里不添加，因为应该已经在消息中了
    // 相反，我们添加状态快照

    // L1: 状态快照
    result.push(createStateSnapshotMessage(formatStateSnapshot(options.state || ({} as AgentState))));

    // 根据级别计算保留多少条最近消息
    const keepCount = this.getRecentKeepCount(level);

    // L3: 最近消息
    const recent = recentMessages.slice(-keepCount);
    result.push(...recent);

    // L4: 相关工具摘要（L2+ 级别）
    if (level !== 'clean' && toolDigests.length > 0) {
      const digestMessage = this.createDigestsMessage(toolDigests.slice(-5));
      result.push(digestMessage);
    }

    // 过渡消息
    if (transitionMessage) {
      result.push(createCompactionMessage(transitionMessage, 0));
    }

    return result;
  }

  /**
   * 创建最小化的紧急快照
   * 用于 L5 紧急级别，仅保留最小状态和最后几条消息
   */
  buildEmergency(state: AgentState, systemPrompt: string, lastMessages: AgentMessage[]): AgentMessage[] {
    const result: AgentMessage[] = [];

    // 最小化状态
    const minimalState = this.formatMinimalState(state);
    result.push(createStateSnapshotMessage(minimalState));

    // 最后 2-3 条消息
    result.push(...lastMessages.slice(-RECENT_KEEP.l5));

    result.push(createCompactionMessage(
      '[系统·紧急] 上下文已极限压缩。请查看当前状态，换方案继续。不要重复之前的失败尝试。',
      0,
    ));

    return result;
  }

  /**
   * 根据压缩级别获取保留的最近消息数
   */
  private getRecentKeepCount(level: CompressionLevel): number {
    switch (level) {
      case 'clean': return RECENT_KEEP.l2;
      case 'window': return RECENT_KEEP.l2;
      case 'collapse': return RECENT_KEEP.l3;
      case 'snapshot': return RECENT_KEEP.l4;
      case 'emergency': return RECENT_KEEP.l5;
      default: return RECENT_KEEP.l2;
    }
  }

  /**
   * 创建工具摘要消息
   * 将多个工具摘要格式化为一条消息
   */
  private createDigestsMessage(digests: ToolDigest[]): AgentMessage {
    const lines = ['【工具执行摘要】'];
    for (const d of digests) {
      const statusIcon = d.status === 'success' ? '✓' : '✗';
      lines.push(`${statusIcon} [${d.tool}] ${d.summary}`);
      if (d.errors.length > 0) {
        for (const err of d.errors.slice(0, 2)) {
          lines.push(`   错误: ${err}`);
        }
      }
      if (d.filesChanged.length > 0) {
        lines.push(`   文件: ${d.filesChanged.join(', ')}`);
      }
    }
    return createToolDigestMessage(lines.join('\n'));
  }

  /**
   * 格式化最小化状态（紧急模式用）
   * 只保留最关键的信息
   */
  private formatMinimalState(state: AgentState): string {
    const lines = ['═══ 紧急上下文 ═══', ''];
    lines.push(`【目标】${state.task.goal || '(未知)'}`);
    
    const activeErrors = state.errors.filter(e => !e.resolved);
    if (activeErrors.length > 0) {
      lines.push(`【问题】${activeErrors[0].error}`);
    }
    
    if (state.workspace.modifiedFiles.length > 0) {
      lines.push(`【修改】${state.workspace.modifiedFiles.map(f => f.path).join(', ')}`);
    }
    
    const criticalConstraints = state.constraints.filter(c => c.priority === 'critical');
    if (criticalConstraints.length > 0) {
      lines.push(`【约束】${criticalConstraints.map(c => c.content).join('; ')}`);
    }
    
    if (state.failedAttempts.length > 0) {
      lines.push(`【已尝试${state.failedAttempts.length}次】请换思路，不要重复失败。`);
    }
    
    lines.push('═════════════════');
    return lines.join('\n');
  }
}
