/**
 * VSCode 配置读取：把 contributes.configuration 中的 agentpack.* 设置聚合成 AgentConfig。
 *
 * 调用 syncApiKeysToEnv 把 apiKey 同步到 process.env（复用 agentpack 的 getEnvApiKey 兜底），
 * 避免在本包自定义 streamFn / aiModel。
 */

import * as vscode from 'vscode';
import { BUILTIN_PROVIDERS } from 'agentpack';
import { expandHome, syncApiKeysToEnv } from './config-env';

export interface AgentConfig {
  /** 模型提供商（如 deepseek / openai / anthropic） */
  provider: string;
  /** 模型 ID（留空则取该 provider 推荐模型） */
  model: string;
  /** provider id → apiKey（来自 settings agentpack.apiKey.*） */
  apiKeys: Record<string, string>;
  /** 跨会话记忆配置 */
  memory: { enabled: boolean; baseDir: string };
  /** 会话持久化目录（空则走扩展 globalStorage/sessions） */
  sessionDir: string;
  /** 启用的工具子集（空数组 = 全部 7 个） */
  enabledTools: string[];
}

/** 从 VSCode settings 读取并展开路径 */
export function readAgentConfig(): AgentConfig {
  const cfg = vscode.workspace.getConfiguration('agentpack');

  const apiKeys: Record<string, string> = {};
  for (const id of [
    'openai',
    'deepseek',
    'anthropic',
    'groq',
    'google',
    'openrouter',
    'mistral',
    'xai',
    'cerebras',
    'together',
    'fireworks',
    'nvidia',
    'moonshot',
  ]) {
    const key = cfg.get<string>(`apiKey.${id}`, '');
    if (key) apiKeys[id] = key;
  }

  return {
    provider: cfg.get<string>('provider', 'deepseek'),
    model: cfg.get<string>('model', ''),
    apiKeys,
    memory: {
      enabled: cfg.get<boolean>('memory.enabled', true),
      baseDir: expandHome(cfg.get<string>('memory.baseDir', '')),
    },
    sessionDir: expandHome(cfg.get<string>('sessionDir', '')),
    enabledTools: cfg.get<string[]>('enabledTools', []),
  };
}

/** 读取配置并把 apiKey 同步到 process.env，返回 { config, written } */
export function loadConfigAndSyncEnv(): {
  config: AgentConfig;
  written: Record<string, string>;
} {
  const config = readAgentConfig();
  const written = syncApiKeysToEnv(config.apiKeys, BUILTIN_PROVIDERS);
  return { config, written };
}
