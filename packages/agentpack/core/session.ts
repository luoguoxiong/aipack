/**
 * packages/core/session.ts - 会话持久化契约层
 *
 * 定义会话存储的数据格式与适配器接口。
 * 实现（memory/file）位于 packages/session/，遵循单向依赖：session → core。
 *
 * 设计要点：
 * - 线性结构：messages 平铺 + 元数据（模型、用量），不做树形分支（YAGNI）
 * - version 字段预留兼容，未来结构升级可平滑迁移
 * - 存储接口仿 src/storage 的 adapter 模式，但不依赖 src/
 */

import type { Message, Usage } from './types';

/** 当前会话数据格式版本 */
export const SESSION_VERSION = 1;

/** 会话模型信息（最后使用的模型） */
export interface SessionModel {
  provider: string;
  modelId: string;
}

/** 持久化会话数据（线性结构） */
export interface StoredSession {
  key: string;
  version: number;
  messages: Message[];
  model: SessionModel | null;
  usage: Usage;
  createdAt: string;
  updatedAt: string;
}

/** 会话存储适配器接口 */
export interface SessionStorage {
  load(key: string): Promise<StoredSession | null>;
  save(key: string, session: StoredSession): Promise<void>;
  delete(key: string): Promise<boolean>;
  list(): Promise<string[]>;
}

/** 文件存储选项 */
export interface FileSessionStorageOptions {
  /** 存储根目录，默认 <pwd>/.agentpack/sessions */
  baseDir?: string;
  /** 过期时间（毫秒），超过 updatedAt 的会话在加载/列举时清理 */
  maxAge?: number;
  /** 持久化消息条数上限（保留最新 N 条，0 表示不限，默认 0） */
  maxStoredMessages?: number;
}

/** 内存存储选项 */
export interface MemorySessionStorageOptions {
  /** 过期时间（毫秒），超过 updatedAt 的会话在加载时清理 */
  maxAge?: number;
}
