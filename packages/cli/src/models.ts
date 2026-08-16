/**
 * packages/cli/src/models.ts
 *
 * 内置模型目录：按提供商分组展示，标注 API Key 配置状态。
 */

import { getBuiltinModels, getBuiltinProviders, getEnvApiKey } from '@aipack-ai/agent';

export interface ModelEntry {
  provider: string;
  providerName: string;
  id: string;
  name: string;
  hasKey: boolean;
}

export function listModels(): ModelEntry[] {
  const providerName = new Map(
    getBuiltinProviders().map((p) => [p.id, p.name]),
  );

  return getBuiltinModels().map((m) => ({
    provider: m.provider,
    providerName: providerName.get(m.provider) ?? m.provider,
    id: m.id,
    name: m.name,
    hasKey: !!getEnvApiKey(m.provider),
  }));
}

/** 已配置 API Key 的提供商列表 */
export function listConfiguredProviders(): string[] {
  return getBuiltinProviders()
    .filter((p) => !!getEnvApiKey(p.id))
    .map((p) => p.id);
}

/** 分组打印模型目录（models 命令的输出） */
export function printModels(): void {
  const entries = listModels();
  const configured = listConfiguredProviders();

  if (configured.length > 0) {
    console.log(`已配置 API Key 的提供商：${configured.join(', ')}`);
  } else {
    console.log('⚠️  未检测到任何 API Key');
  }
  console.log('');

  const byProvider = new Map<string, ModelEntry[]>();
  for (const entry of entries) {
    if (!byProvider.has(entry.provider)) byProvider.set(entry.provider, []);
    byProvider.get(entry.provider)!.push(entry);
  }

  let total = 0;
  for (const [provider, models] of byProvider) {
    const name = models[0]?.providerName ?? provider;
    console.log(`  ${name} (${provider}):`);
    for (const m of models) {
      const key = m.hasKey ? '✓' : '✗';
      console.log(`    ${key} ${m.id.padEnd(45)} ${m.name}`);
      total++;
    }
    console.log('');
  }

  console.log(`共 ${total} 个内置模型`);
}
