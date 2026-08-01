/**
 * 会话记忆 - 内存中的会话状态存储（P0 实现）
 *
 * 功能：
 * - 存储当前会话的 Agent 状态
 * - 存储最近上下文（消息列表）
 * - 存储工具摘要历史
 * - 从消息中提取需要写入记忆的内容（用户偏好、决策等）
 *
 * 三层记忆系统的最底层：会话记忆
 * - 会话记忆（当前会话）
 * - 工作区记忆（跨会话，项目级）
 * - 用户记忆（跨项目，用户级）
 */

import type { AgentMessage } from '../../agent';
import type { AgentState, SessionMemory, ToolDigest } from '../types';
import { getMessageContent } from '../state/message-adapter';

/**
 * 会话记忆存储类
 * 管理当前会话的状态和历史
 */
export class SessionMemoryStore {
  private memory: SessionMemory | null = null;  // 记忆数据
  private sessionId: string;                     // 会话 ID

  constructor(sessionId?: string) {
    this.sessionId = sessionId || `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  /**
   * 初始化/重置会话记忆
   * 设置初始状态
   */
  init(initialState: AgentState): void {
    this.memory = {
      sessionId: this.sessionId,
      agentState: initialState,
      recentContext: [],
      toolDigests: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  /**
   * 更新 Agent 状态
   */
  updateState(state: AgentState): void {
    if (!this.memory) {
      this.init(state);
      return;
    }
    this.memory.agentState = state;
    this.memory.updatedAt = Date.now();
  }

  /**
   * 更新最近上下文（消息列表）
   */
  updateRecentContext(messages: AgentMessage[]): void {
    if (!this.memory) return;
    this.memory.recentContext = [...messages];
    this.memory.updatedAt = Date.now();
  }

  /**
   * 添加工具摘要
   * 最多保留最近 50 条
   */
  addToolDigests(digests: ToolDigest[]): void {
    if (!this.memory) return;
    this.memory.toolDigests.push(...digests);
    // 只保留最近 50 条摘要
    if (this.memory.toolDigests.length > 50) {
      this.memory.toolDigests = this.memory.toolDigests.slice(-50);
    }
    this.memory.updatedAt = Date.now();
  }

  /**
   * 获取当前记忆
   */
  get(): SessionMemory | null {
    return this.memory;
  }

  /**
   * 获取当前状态
   */
  getState(): AgentState | null {
    return this.memory?.agentState || null;
  }

  /**
   * 获取工具摘要列表
   */
  getToolDigests(): ToolDigest[] {
    return this.memory?.toolDigests || [];
  }

  /**
   * 获取会话 ID
   */
  getSessionId(): string {
    return this.sessionId;
  }

  /**
   * 清空记忆
   */
  clear(): void {
    this.memory = null;
  }

  /**
   * 简单的记忆写入提取器（P0：基于规则）
   * 从消息中提取需要持久化的信息
   *
   * @param messages 消息列表
   * @returns 提取出的用户偏好和决策
   */
  extractWrites(messages: AgentMessage[]): {
    userPreferences: string[];   // 用户偏好
    decisions: string[];         // 决策记录
  } {
    const userPreferences: string[] = [];
    const decisions: string[] = [];

    for (const msg of messages) {
      if (msg.role !== 'user') continue;
      const content = getMessageContent(msg);
      if (!content) continue;

      // "记住我喜欢..." 等模式
      if (/(记住|remember|note that).*?(喜欢|偏好|prefer|like)/i.test(content)) {
        userPreferences.push(content.slice(0, 200));
      }

      // 决策模式
      if (/(就这么|决定|decided|let's go with|我确认|同意)/i.test(content)) {
        decisions.push(content.slice(0, 200));
      }
    }

    return { userPreferences, decisions };
  }
}
