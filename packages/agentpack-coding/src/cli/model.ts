/**
 * CLI 模型解析 + .env 加载。
 *
 * 复用 agentpack/ai 的模型目录与环境变量探测，不依赖 agentpack-cli。
 */

import fs from 'fs';
import path from 'path';
import { getBuiltinModel, getBuiltinModels, getEnvApiKey } from 'agentpack/ai';
import type { Model as AiModel } from 'agentpack/ai';

/**
 * 加载 .env 文件（~/.agentpack/.env 与 <cwd>/.env）。
 * 已存在的环境变量不被覆盖。支持 # 注释与引号包裹的值。
 */
export function loadEnv(): void {
  const files = [
    path.join(process.env.HOME ?? '', '.agentpack', '.env'),
    path.join(process.cwd(), '.env'),
  ];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf-8');
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = val;
    }
  }
}

/** 是否检测到任意提供商的 API Key */
export function hasAnyApiKey(): boolean {
  return getBuiltinModels().some((m) => !!getEnvApiKey(m.provider));
}

/**
 * 解析模型（分层兜底）。无可用模型时打印可读错误并退出。
 */
export function resolveModelFromArgs(opts: {
  provider?: string;
  model?: string;
}): AiModel {
  const { provider, model } = opts;
  if (provider && model) {
    const m = getBuiltinModel(provider, model);
    if (m) return m;
  }
  if (model) {
    const byId = getBuiltinModels().find((m) => m.id === model);
    if (byId) return byId;
  }
  const fallback = getBuiltinModels().find((m) => !!getEnvApiKey(m.provider));
  if (fallback) return fallback;

  console.error('❌ 未检测到任何 API Key。');
  console.error('   请配置环境变量，例如：export DEEPSEEK_API_KEY="your-key"');
  console.error('   或写入 ~/.agentpack/.env / <cwd>/.env');
  process.exit(1);
}
