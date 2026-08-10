/**
 * 工厂入口：createCodingAgent(options) → Promise<CodingAgent>
 *
 * 封装模型解析 + Runtime 装配 + coding 工具集 + system prompt，编程式一行起跑。
 * 参考 aipack-cli/src/runtime.ts 的模型解析与 createRuntime 装配模式。
 *
 * 可选 memory 选项动态 import aipack-memory（避免硬依赖）。
 *
 * 用法：
 *   const agent = await createCodingAgent({ provider: 'deepseek', model: 'deepseek-chat' });
 *   const result = await agent.runtime.run(createRequest('读 package.json'));
 *   await agent.close();
 */

import {
  createRuntime,
  createFileSessionStorage,
  adaptAiModel,
  createStreamFnFromAi,
} from '@aipack/agent';
import type { Runtime, Tool, Extension, ContextTransformer, StreamFn, AiModel } from '@aipack/agent';
import { createCodingTools } from './tools';
import { PermissionManager } from './permission';
import { resolveModel } from './model';
import { DEFAULT_CODING_SYSTEM_PROMPT } from './prompt';
import type { CodingAgentOptions, CodingAgent } from './types';

/**
 * 解析 AI 模型（分层兜底，见 src/model.ts）：
 * 1. aiModel 直接传入 → 用它
 * 2. provider + model 精确查找
 * 3. 全局按 model id 查找
 * 4. 选择第一个已配置 API Key 的提供商的模型
 * 5. 全部失败则抛出可读错误
 */
function resolveAiModel(
  provider: string | undefined,
  model: string | undefined,
): AiModel {
  const m = resolveModel(provider, model);
  if (m) return m;
  throw new Error(
    '未找到可用模型。请配置 API Key（如 DEEPSEEK_API_KEY / OPENAI_API_KEY）或显式传入 aiModel。',
  );
}

export async function createCodingAgent(
  options: CodingAgentOptions = {},
): Promise<CodingAgent> {
  // 1. 解析模型
  const aiModel: AiModel =
    options.aiModel ?? resolveAiModel(options.provider, options.model);
  const streamFn: StreamFn = options.streamFn ?? createStreamFnFromAi(aiModel);

  // 2. workspace（默认 cwd）
  const workspace = options.workspace ?? process.cwd();

  // 3. 权限管理器
  const permission = new PermissionManager(options.permission ?? {});

  // 4. 工具集
  const codingTools = createCodingTools(
    { workspace, permission },
    { enabledTools: options.enabledTools },
  );
  let allTools: Tool[] = [...codingTools, ...(options.extraTools ?? [])];
  let extensions: Extension[] = [...(options.extensions ?? [])];
  let transformers: ContextTransformer[] = [...(options.transformers ?? [])];

  // 5. 可选 memory 集成（动态 import，避免硬依赖）
  if (options.memory) {
    try {
      const memMod = await import('@aipack/memory');
      const memOpts = typeof options.memory === 'object' ? options.memory : {};
      const mem = memMod.createMemoryPlugin({
        baseDir: memOpts.baseDir ?? '~/.aipack/memory',
        maxMemories: memOpts.maxMemories,
      });
      const installed = mem.install();
      allTools = [...allTools, ...installed.tools];
      extensions = [...extensions, ...installed.extensions];
      transformers = [...transformers, ...installed.transformers];
    } catch (err) {
      console.warn(
        `⚠️  启用 memory 集成但加载 aipack-memory 失败，已跳过：${(err as Error).message}`,
      );
    }
  }

  // 6. 创建 runtime（sessionKey 不再编入 Runtime；由 CodingAgent.sessionKey 持有，
  //    调用方在 createRequest / getMessages / clearSession 时显式传递）
  const sessionKey = options.sessionKey ?? 'default';
  const runtime: Runtime = createRuntime({
    model: adaptAiModel(aiModel),
    streamFn,
    systemPrompt: options.systemPrompt ?? DEFAULT_CODING_SYSTEM_PROMPT,
    workspace,
    tools: allTools,
    extensions: extensions.length > 0 ? extensions : undefined,
    transformers: transformers.length > 0 ? transformers : undefined,
    sessionStorage: options.sessionDir
      ? createFileSessionStorage({ baseDir: options.sessionDir })
      : undefined,
  });

  return {
    runtime,
    permission,
    tools: allTools,
    model: aiModel,
    sessionKey,
    async close() {
      await runtime.close();
    },
  };
}
