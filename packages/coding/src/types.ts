/**
 * aipack-coding 类型定义。
 *
 * CodingToolContext 贯穿所有工具，提供 workspace 根目录与权限管理器；
 * 各工厂函数的 options 与返回类型也在此声明。
 */

import type { Tool, Extension, ContextTransformer } from '@aipack/agent';
import type { PermissionManager, PermissionOptions } from './permission';

/** 工具共享上下文：所有 coding 工具通过它获取 workspace 与权限 */
export interface CodingToolContext {
  /** workspace 根目录（绝对路径），所有相对路径基于此解析 */
  workspace: string;
  /** 权限管理器（run_command 使用；其他工具可不传） */
  permission?: PermissionManager;
}

/** createCodingTools 的选项 */
export interface CodingToolsOptions {
  /** 启用的工具子集（按 name 过滤），缺省为全部 7 个 */
  enabledTools?: string[];
}

/** createCodingPlugin 的选项 */
export interface CodingPluginOptions {
  /** workspace 根目录（绝对路径），必传 */
  workspace: string;
  /** 权限策略选项（白名单 + 确认回调） */
  permission?: PermissionOptions;
  /** 启用的工具子集 */
  enabledTools?: string[];
}

/** createCodingPlugin 返回的插件对象 */
export interface CodingPlugin {
  /** 已装配的工具列表 */
  tools: Tool[];
  /** 权限管理器（编程式调用，如动态 addRule） */
  permission: PermissionManager;
  /** 默认 system prompt */
  systemPrompt: string;
  /** 转换器列表（coding 默认为空，保持插件形态一致） */
  transformers: ContextTransformer[];
  /** 返回 tools + transformers，供 aipack.config.js 展开 */
  install(): { tools: Tool[]; transformers: ContextTransformer[] };
}

/** createCodingAgent 的选项 */
export interface CodingAgentOptions {
  /** 模型提供商（如 deepseek / openai / anthropic），缺省按 API Key 自动选择 */
  provider?: string;
  /** 模型 ID（如 deepseek-chat），缺省按提供商取推荐 */
  model?: string;
  /** 已解析的 ai 模型（优先级高于 provider/model） */
  aiModel?: import('@aipack/agent').AiModel;
  /** 自定义 streamFn（优先级高于 aiModel） */
  streamFn?: import('@aipack/agent').StreamFn;
  /** system prompt（默认用 DEFAULT_CODING_SYSTEM_PROMPT） */
  systemPrompt?: string;
  /** workspace 根目录（默认 process.cwd()） */
  workspace?: string;
  /** 会话存储目录（不传则不持久化） */
  sessionDir?: string;
  /** 会话标识（单会话;默认 'default'）。多会话场景请创建多个 agent 实例 */
  sessionKey?: string;
  /** 额外工具（与 coding 工具合并，便于注入 memory 工具等） */
  extraTools?: Tool[];
  /** 额外扩展（如 LoggingExtension / memory capture） */
  extensions?: Extension[];
  /** 额外转换器（如 memory injection） */
  transformers?: ContextTransformer[];
  /** 权限策略选项 */
  permission?: PermissionOptions;
  /** 启用的工具子集（默认全部 7 个） */
  enabledTools?: string[];
  /** 启用 aipack-memory 集成（动态 import，避免硬依赖） */
  memory?: boolean | { baseDir?: string; maxMemories?: number };
}

/** createCodingAgent 返回的 agent 对象 */
export interface CodingAgent {
  /** 装配好的 runtime */
  runtime: import('@aipack/agent').Runtime;
  /** 权限管理器（编程式调用） */
  permission: PermissionManager;
  /** 工具列表（已注册到 runtime） */
  tools: Tool[];
  /** 实际解析到的模型（供 /model 等展示用） */
  model: import('@aipack/agent').AiModel;
  /** 会话标识（由 options.sessionKey 决定，默认 'default'）；调用方据此在 createRequest / getMessages / clearSession 中显式传递 */
  sessionKey: string;
  /** 关闭 runtime 释放资源 */
  close(): Promise<void>;
}

/** 内置工具名列表（用于 enabledTools 校验与文档） */
export const CODING_TOOL_NAMES = [
  'read_file',
  'write_file',
  'edit_file',
  'list_directory',
  'run_command',
  'grep',
  'glob',
] as const;

export type CodingToolName = (typeof CODING_TOOL_NAMES)[number];
