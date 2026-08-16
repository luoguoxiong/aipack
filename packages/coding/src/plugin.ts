/**
 * 插件聚合入口：createCodingPlugin(options) → { tools, permission, systemPrompt, transformers, install() }
 *
 * 镜像 aipack-memory 的 install 模式。
 * 装配 7 个 coding 工具 + PermissionManager，供 aipack.config.js 展开。
 *
 * 用法（aipack.config.js）：
 *   import { createCodingPlugin } from '@aipack-ai/coding';
 *   const coding = createCodingPlugin({ workspace: process.cwd() });
 *   const r = coding.install();
 *   export default {
 *     ...,                       // provider, model, systemPrompt, sessions...
 *     systemPrompt: coding.systemPrompt,
 *     tools: r.tools,
 *   };
 */

import type { Tool, ContextTransformer } from '@aipack-ai/agent';
import { createCodingTools } from './tools';
import { PermissionManager } from './permission';
import { DEFAULT_CODING_SYSTEM_PROMPT } from './prompt';
import type { CodingPluginOptions, CodingPlugin } from './types';

export function createCodingPlugin(options: CodingPluginOptions): CodingPlugin {
  if (!options.workspace) {
    throw new Error('createCodingPlugin: workspace 不能为空');
  }

  const permission = new PermissionManager(options.permission ?? {});
  const tools: Tool[] = createCodingTools(
    { workspace: options.workspace, permission },
    { enabledTools: options.enabledTools },
  );

  // coding 默认不需要 hook 生命周期，transformers 留空以保持插件形态一致
  const transformers: ContextTransformer[] = [];

  return {
    tools,
    permission,
    systemPrompt: DEFAULT_CODING_SYSTEM_PROMPT,
    transformers,
    install() {
      return { tools, transformers };
    },
  };
}
