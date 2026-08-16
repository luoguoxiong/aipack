/**
 * 工具装配入口：createCodingTools(ctx, options) → Tool[]
 *
 * 装配 7 个 coding 工具，按 enabledTools 过滤子集。
 * 与 createCodingPlugin / createCodingAgent 共享。
 */

import type { Tool } from '@aipack-ai/agent';
import type { CodingToolContext, CodingToolsOptions } from '../types';
import { createReadFileTool } from './read-file';
import { createWriteFileTool } from './write-file';
import { createEditFileTool } from './edit-file';
import { createListDirectoryTool } from './list-directory';
import { createRunCommandTool } from './run-command';
import { createGrepTool } from './grep';
import { createGlobTool } from './glob';

export { createReadFileTool } from './read-file';
export { createWriteFileTool } from './write-file';
export { createEditFileTool } from './edit-file';
export { createListDirectoryTool } from './list-directory';
export { createRunCommandTool } from './run-command';
export { createGrepTool } from './grep';
export { createGlobTool } from './glob';

/**
 * 装配全部 coding 工具。
 * @param ctx 工具上下文（workspace + permission）
 * @param options.enabledTools 启用的工具名子集（缺省为全部 7 个）
 */
export function createCodingTools(
  ctx: CodingToolContext,
  options: CodingToolsOptions = {},
): Tool[] {
  const all: Tool[] = [
    createReadFileTool(ctx),
    createWriteFileTool(ctx),
    createEditFileTool(ctx),
    createListDirectoryTool(ctx),
    createRunCommandTool(ctx),
    createGrepTool(ctx),
    createGlobTool(ctx),
  ];

  if (options.enabledTools && options.enabledTools.length > 0) {
    const enabled = new Set(options.enabledTools);
    return all.filter((t) => enabled.has(t.name));
  }
  return all;
}
