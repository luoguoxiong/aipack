/**
 * 会话状态管理（从 AgentRuntime 拆出）：
 * - 多会话内存状态表（key = sessionKey）+ LRU 淘汰
 * - 同会话串行队列锁（acquire/release，防消息数组交错与 abort 覆盖）
 * - waitForIdle（promise 唤醒，无轮询）
 */

import type { Message } from '../core';
import {
  DEFAULT_MAX_SESSIONS,
  createSessionState,
  type SessionState,
} from './shared';

export class SessionStore {
  /** 多会话状态表：key = sessionKey。模型/工具/扩展/转换器等资源跨会话共享 */
  private readonly _sessions: Map<string, SessionState>;
  /** 内存会话状态表 LRU 上限 */
  private readonly _maxSessions: number;
  /** 默认会话 key（常量 'default'；请求未指定 sessionKey 时路由到此会话） */
  readonly defaultKey: string;

  constructor(defaultKey: string, maxSessions: number = DEFAULT_MAX_SESSIONS) {
    this.defaultKey = defaultKey;
    this._maxSessions = maxSessions;
    this._sessions = new Map();
    // 默认会话预先入表，保证未指定 sessionKey 的请求路由到它
    this._sessions.set(defaultKey, createSessionState());
  }

  /**
   * 获取（懒创建）会话状态。同一 Runtime 下不同 sessionKey 的消息历史、
   * 串行队列、abort 控制相互独立；共享模型/工具/扩展/转换器。
   * 超过 maxSessions 时淘汰最久未用的非活动会话（仅清内存态，不删存储）。
   */
  ensure(key: string): SessionState {
    let session = this._sessions.get(key);
    if (session) {
      // 刷新 LRU 顺序（Map 尾 = 最近使用）
      this._sessions.delete(key);
      this._sessions.set(key, session);
      return session;
    }
    session = createSessionState();
    this._sessions.set(key, session);
    this.evictIdleSessions();
    return session;
  }

  /** 只读访问（不创建、不刷新 LRU；会话不存在返回 undefined） */
  peek(key: string): SessionState | undefined {
    return this._sessions.get(key);
  }

  /** LRU 淘汰：仅淘汰非活动（未运行、未排队）的最久未用会话 */
  private evictIdleSessions(): void {
    if (this._sessions.size <= this._maxSessions) return;
    for (const [key, session] of this._sessions) {
      if (this._sessions.size <= this._maxSessions) break;
      // 运行中 / 已持有锁（入队待执行）不淘汰
      if (session.isStreaming || session.lockHeld) continue;
      // 淘汰前唤醒所有 waitForIdle 等待者，避免其随会话一起被丢弃而永久挂起
      if (session.idleResolvers.length > 0) {
        const resolvers = session.idleResolvers.splice(0);
        for (const resolve of resolvers) resolve();
      }
      this._sessions.delete(key);
    }
  }

  /** 当前活跃的会话 key 列表（含默认会话） */
  keys(): string[] {
    return Array.from(this._sessions.keys());
  }

  /** 某会话是否存在（内存中） */
  has(key: string): boolean {
    return this._sessions.has(key);
  }

  /**
   * 获取同一会话的执行锁：返回 release 函数，调用后释放。
   * 同一 sessionKey 的 run/stream 会串行执行，避免消息数组交错、
   * abortController 互相覆盖、hydrate 竞态。
   */
  async acquire(session: SessionState): Promise<() => void> {
    let release!: () => void;
    const prev = session.queue;
    session.queue = new Promise<void>(resolve => {
      release = () => resolve();
    });
    await prev;
    session.lockHeld = true;
    return () => {
      session.lockHeld = false;
      release();
    };
  }

  /** 标记会话空闲并唤醒所有 waitForIdle 等待者 */
  markIdle(session: SessionState): void {
    session.isStreaming = false;
    session.abortController = null;
    if (session.idleResolvers.length > 0) {
      const resolvers = session.idleResolvers.splice(0);
      for (const resolve of resolvers) resolve();
    }
  }

  /** 指定会话的消息列表深拷贝（避免外部直接修改会话内部状态；不存在返回空数组） */
  getMessagesCopy(key: string): Message[] {
    const session = this._sessions.get(key);
    if (!session) return [];
    const messages = session.messages;
    try {
      return structuredClone(messages);
    } catch {
      return JSON.parse(JSON.stringify(messages));
    }
  }

  /**
   * 指定会话消息的只读视图（高频轮询用）：仅浅拷贝数组（O(n) 引用，
   * 不做 structuredClone 深拷贝），消息对象与内部共享——调用方不得修改，
   * 需要可变副本时用 getMessagesCopy。
   */
  peekMessages(key: string): readonly Message[] {
    return this._sessions.get(key)?.messages.slice() ?? [];
  }

  /** 等待指定会话空闲（基于 promise，无轮询；会话不存在或非运行中直接返回） */
  async waitForIdle(key: string, timeoutMs?: number): Promise<void> {
    const session = this._sessions.get(key);
    if (!session || !session.isStreaming) return;

    if (timeoutMs === undefined) {
      await new Promise<void>(resolve => {
        session.idleResolvers.push(resolve);
      });
      return;
    }

    // 带超时等待：超时 reject 并把自己从等待队列移除，避免 markIdle 唤醒残留 resolver
    await new Promise<void>((resolve, reject) => {
      const resolver = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        const i = session.idleResolvers.indexOf(resolver);
        if (i >= 0) session.idleResolvers.splice(i, 1);
        reject(new Error(
          `[Runtime] waitForIdle 超时（${timeoutMs}ms）: ${key}`,
        ));
      }, timeoutMs);
      session.idleResolvers.push(resolver);
    });
  }

  /** 清除指定会话消息（仅内存；下次 run 会从存储恢复） */
  clearMessages(key: string): void {
    const session = this._sessions.get(key);
    if (!session) return;
    session.messages = [];
    session.hydrated = false;
  }

  /**
   * 删除指定会话（仅内存态）：等待在途任务完成后移除，返回被移除的会话。
   */
  async remove(key: string): Promise<SessionState | undefined> {
    const session = this._sessions.get(key);
    if (session) {
      await session.queue;
      this._sessions.delete(key);
    }
    return session;
  }

  /** 关闭用：等待所有会话的在途任务完成后清空状态表 */
  async drainAndClear(): Promise<void> {
    await Promise.allSettled(Array.from(this._sessions.values(), s => s.queue));
    for (const session of this._sessions.values()) {
      session.messages = [];
      session.hydrated = false;
    }
    this._sessions.clear();
  }
}
