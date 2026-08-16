/**
 * packages/session-manager - 多会话管理器
 *
 * 让多个会话共享同一个 Runtime 实例（模型/工具/扩展/转换器等资源跨会话共享），
 * 每个会话按 sessionKey 拥有独立的：
 *   - 消息历史（内存态，可经 SessionStorage 持久化）
 *   - 串行队列（同会话 run/stream 依次执行）
 *   - abort / busy / idle 状态
 *
 * 底层由 AgentRuntime 的内建多会话路由（request.sessionKey）实现，
 * SessionManager 提供面向多租户的便捷门面：自动为请求附加 sessionKey，
 * 并暴露按会话粒度的消息/状态/生命周期操作。
 *
 * 用法：
 *   const sm = SessionManager.create({
 *     runtimeOptions: { model, streamFn, tools, sessionStorage },
 *   });
 *   await sm.run('你好', 'user-1');        // 会话 user-1
 *   await sm.run('你好', 'user-2');        // 会话 user-2（历史互相隔离）
 *   sm.getMessages('user-1');              // 只读 user-1 的历史
 *   sm.abort('user-1');                    // 只中止 user-1 的运行
 */

import type {
  Runtime,
  RuntimeOptions,
  Request,
  Result,
  ResultChunk,
  Message,
} from '../core';
import { createRequest } from '../core';
import { createRuntime } from '../runtime';

// ─── 选项 ─────────────────────────────────────────────────────────

export interface SessionManagerOptions {
  /** 共享的 Runtime 实例（多会话共享其模型/工具/扩展/转换器） */
  runtime?: Runtime;
  /** 未提供 runtime 时，据此创建一个共享 Runtime */
  runtimeOptions?: RuntimeOptions;
}

// ─── SessionManager ────────────────────────────────────────────────

export class SessionManager {
  private _runtime: Runtime;

  private constructor(runtime: Runtime) {
    this._runtime = runtime;
  }

  /** 创建 SessionManager：传 runtime 复用已有实例，否则用 runtimeOptions 新建 */
  static create(options: SessionManagerOptions = {}): SessionManager {
    const runtime = options.runtime ?? createRuntime(options.runtimeOptions);
    return new SessionManager(runtime);
  }

  /** 共享的 Runtime 实例（可直接操作工具/模型/扩展） */
  get runtime(): Runtime {
    return this._runtime;
  }

  /** 把 string | Request 归一化为 Request，并附加会话 key */
  private toRequest(message: string | Request, sessionKey?: string): Request {
    if (typeof message === 'string') {
      return createRequest(message, sessionKey ? { sessionKey } : undefined);
    }
    // 显式 sessionKey 优先于 request.sessionKey；两者都无则由 Runtime 路由到默认会话
    return sessionKey ? { ...message, sessionKey } : message;
  }

  /** 在指定会话上运行（默认：request 自带或 Runtime 默认会话） */
  async run(message: string | Request, sessionKey?: string): Promise<Result> {
    return this._runtime.run(this.toRequest(message, sessionKey));
  }

  /** 在指定会话上流式运行 */
  async *stream(
    message: string | Request,
    sessionKey?: string,
  ): AsyncGenerator<ResultChunk> {
    yield* this._runtime.stream(this.toRequest(message, sessionKey));
  }

  /** 读取指定会话的消息历史（不存在返回空数组） */
  getMessages(sessionKey?: string): Message[] {
    return this._runtime.getMessages(sessionKey);
  }

  /** 中止指定会话的运行 */
  abort(sessionKey?: string): void {
    this._runtime.abort(sessionKey);
  }

  /** 指定会话是否正在运行 */
  isBusy(sessionKey?: string): boolean {
    return this._runtime.isBusy(sessionKey);
  }

  /** 等待指定会话空闲（timeoutMs 可选，超时 reject） */
  waitForIdle(sessionKey?: string, timeoutMs?: number): Promise<void> {
    return this._runtime.waitForIdle(sessionKey, timeoutMs);
  }

  /** 清除指定会话消息（仅内存） */
  clearSession(sessionKey?: string): void {
    this._runtime.clearSession(sessionKey);
  }

  /** 删除指定会话（内存 + 存储） */
  deleteSession(sessionKey?: string): Promise<boolean> {
    return this._runtime.deleteSession(sessionKey);
  }

  /** 某会话是否存在于内存 */
  hasSession(sessionKey: string): boolean {
    return this._runtime.hasSession(sessionKey);
  }

  /** 当前活跃的会话 key 列表 */
  listSessions(): string[] {
    return this._runtime.getSessionKeys();
  }

  /** 关闭共享 Runtime */
  async close(): Promise<void> {
    await this._runtime.close();
  }
}

// ─── 工厂 ─────────────────────────────────────────────────────────

export function createSessionManager(
  options?: SessionManagerOptions,
): SessionManager {
  return SessionManager.create(options);
}
