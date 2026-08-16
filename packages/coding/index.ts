/**
 * aipack-coding —— aipack coding 工具集 + coding agent 工厂 + CLI
 *
 * 双形态对外：
 *   - createCodingPlugin()  工具集插件，注入 aipack.config.js
 *   - createCodingAgent()   开箱即用工厂，封装模型解析 + Runtime + 工具集
 *
 * 7 个零依赖 coding 工具：read_file / write_file / edit_file / list_directory
 *                          / run_command / grep / glob
 * run_command 内置权限策略（白名单 allow/deny/confirm + 确认回调）。
 *
 * 快速开始：
 *   import { createCodingAgent } from '@aipack-ai/coding';
 *   const agent = await createCodingAgent({ provider: 'deepseek', model: 'deepseek-chat' });
 *   const result = await agent.runtime.run(createRequest('读 package.json 并总结'));
 *   await agent.close();
 */

// ─── 插件 / 工厂 ────────────────────────────────────────────────────
export { createCodingPlugin } from './src/plugin';
export { createCodingAgent } from './src/factory';
export { resolveModel } from './src/model';

// ─── 工具集 ──────────────────────────────────────────────────────────
export { createCodingTools } from './src/tools';
export { createReadFileTool } from './src/tools/read-file';
export { createWriteFileTool } from './src/tools/write-file';
export { createEditFileTool } from './src/tools/edit-file';
export { createListDirectoryTool } from './src/tools/list-directory';
export { createRunCommandTool } from './src/tools/run-command';
export { createGrepTool } from './src/tools/grep';
export { createGlobTool } from './src/tools/glob';

// ─── 权限策略 ────────────────────────────────────────────────────────
export { PermissionManager } from './src/permission';
export type {
  PermissionDecision,
  ConfirmResult,
  ConfirmContext,
  PermissionRule,
  PermissionOptions,
} from './src/permission';

// ─── system prompt ───────────────────────────────────────────────────
export { DEFAULT_CODING_SYSTEM_PROMPT } from './src/prompt';

// ─── 类型 ────────────────────────────────────────────────────────────
export type {
  CodingToolContext,
  CodingToolsOptions,
  CodingPluginOptions,
  CodingPlugin,
  CodingAgentOptions,
  CodingAgent,
  CodingToolName,
} from './src/types';
export { CODING_TOOL_NAMES } from './src/types';

// ─── 工具函数 ────────────────────────────────────────────────────────
export { resolveWithin, expandHome } from './src/utils/path';
export type { ResolveResult } from './src/utils/path';
export {
  formatLineNumbers,
  isBinary,
  countOccurrences,
  truncateWithHint,
  globToRegex,
  walkDir,
  DEFAULT_IGNORE_DIRS,
} from './src/utils/text';
export type { WalkOptions } from './src/utils/text';

// ─── 从 aipack 再导出常用类型（方便单一 import） ───────────────────
export type { Tool, ToolResult, Extension, ContextTransformer, StreamFn } from '@aipack-ai/agent';
