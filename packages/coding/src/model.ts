/**
 * 模型解析共享逻辑（分层兜底）。
 *
 * factory 与 CLI 复用同一套解析规则：
 * 1. provider + model 精确查找
 * 2. 全局按 model id 查找
 * 3. 第一个已配置 API Key 的提供商的模型
 * 全部未命中返回 undefined（由调用方决定抛错或退出）。
 */

import { getBuiltinModel, getBuiltinModels, getEnvApiKey } from '@aipack-ai/agent';
import type { AiModel } from '@aipack-ai/agent';

export function resolveModel(provider?: string, model?: string): AiModel | undefined {
  if (provider && model) {
    const m = getBuiltinModel(provider, model);
    if (m) return m;
  }
  if (model) {
    const byId = getBuiltinModels().find((m) => m.id === model);
    if (byId) return byId;
  }
  return getBuiltinModels().find((m) => !!getEnvApiKey(m.provider));
}
