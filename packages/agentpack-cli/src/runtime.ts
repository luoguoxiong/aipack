/**
 * packages/agentpack-cli/src/runtime.ts
 *
 * 模型解析 + Runtime 工厂。
 * 基于 agentpack 框架封装：getBuiltinModel + adaptAiModel / createStreamFnFromAi
 * + FileSessionStorage（会话持久化）。
 */

import {
  createRuntime,
  createFileSessionStorage,
  getBuiltinModel,
  getBuiltinModels,
  getEnvApiKey,
  adaptAiModel,
  createStreamFnFromAi,
} from 'agentpack';
import type { Model, Runtime, AiModel } from 'agentpack';
import type { AgentpackConfig } from './config';

/**
 * 解析 AI 模型（分层兜底）：
 * 1. 按配置的 provider + model 精确查找
 * 2. 全局按 model id 查找
 * 3. 选择第一个已配置 API Key 的提供商的模型
 * 4. 全部失败则抛出可读错误
 */
export function resolveAiModel(config: AgentpackConfig): AiModel {
  const byProvider = getBuiltinModel(config.provider, config.model);
  if (byProvider) return byProvider;

  const byId = getBuiltinModels().find((m) => m.id === config.model);
  if (byId) return byId;

  const fallback = getBuiltinModels().find((m) => !!getEnvApiKey(m.provider));
  if (fallback) return fallback;

  throw new Error(
    `未找到模型 "${config.model}"（提供商：${config.provider}），且未检测到任何 API Key。` +
      '运行 "agentpack models" 查看支持的模型。',
  );
}

/**
 * 解析模型并保证所选提供商已配置 API Key：
 * - 所选提供商无 Key 时自动切换到已配置的提供商（打印提示）
 * - 完全无 Key 时打印可读错误并退出
 */
export function resolveModelForCli(config: AgentpackConfig): AiModel {
  const model = resolveAiModel(config);

  if (getEnvApiKey(model.provider)) return model;

  const fallback = getBuiltinModels().find((m) => !!getEnvApiKey(m.provider));
  if (fallback) {
    console.log(
      `⚠️  提供商 "${model.provider}" 未配置 API Key，已切换到 ${fallback.provider}/${fallback.id}`,
    );
    return fallback;
  }

  console.error('❌ 未检测到任何 API Key。');
  console.error('   请在环境变量中配置，例如：export DEEPSEEK_API_KEY="your-key"');
  console.error('   或写入 ~/.agentpack/.env / <cwd>/.env 文件');
  console.error('   运行 "agentpack models" 查看支持的提供商与模型');
  process.exit(1);
}

/**
 * 创建 agentpack Runtime（可选传入已解析的模型，避免二次解析不一致）
 * @param overrides 额外覆盖项，优先级最高（如 replay 回放时禁用工具）
 */
export function createAgentpackRuntime(
  config: AgentpackConfig,
  model?: AiModel,
  sessionKey?: string,
  overrides?: Record<string, unknown>,
): Runtime {
  const aiModel = model ?? resolveAiModel(config);

  // 配置文件透传的 Runtime 选项（tools/extensions 等），优先级高于默认值
  const runtimeOverrides = config.runtime ?? {};

  return createRuntime({
    model: adaptAiModel(aiModel),
    streamFn: createStreamFnFromAi(aiModel),
    systemPrompt: config.systemPrompt,
    workspace: config.workspace,
    sessionKey: sessionKey ?? config.sessionKey,
    sessionStorage: config.sessions.enabled
      ? createFileSessionStorage({
          baseDir: config.sessions.baseDir,
          maxAge: config.sessions.maxAge,
        })
      : undefined,
    ...runtimeOverrides,
    ...overrides,
  });
}

export type { Model, Runtime };
