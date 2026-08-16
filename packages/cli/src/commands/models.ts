/**
 * --list-models：列出内置目录模型（可搜索），标注 API Key 配置状态。
 */
import chalk from 'chalk';
import { getBuiltinProviders, getBuiltinModels, hasProviderConfigured } from '@aipack-ai/agent';

export function listModels(search?: string | true): number {
  const term = typeof search === 'string' ? search.toLowerCase() : undefined;
  let total = 0;

  for (const provider of getBuiltinProviders()) {
    const models = getBuiltinModels(provider.id);
    const matched = term
      ? models.filter(m =>
          m.id.toLowerCase().includes(term) ||
          m.name.toLowerCase().includes(term) ||
          provider.id.includes(term))
      : models;
    if (matched.length === 0) continue;

    const configured = hasProviderConfigured(provider.id);
    const badge = configured ? chalk.green('✓') : chalk.dim('·');
    console.log(`${badge} ${chalk.bold(provider.name)} ${chalk.dim(`(${provider.id})`)}`);

    for (const m of matched) {
      const flags = [
        m.reasoning ? chalk.dim('推理') : null,
        `${(m.contextWindow / 1000) | 0}k`,
      ].filter(Boolean).join(' ');
      console.log(`    ${m.id.padEnd(44)} ${chalk.dim(flags)}`);
      total++;
    }
  }

  console.log(chalk.dim(`\n共 ${total} 个模型。✓ = 已配置 API Key（${getEnvHint()}）`));
  return 0;
}

function getEnvHint(): string {
  const provider = getBuiltinProviders().find(p => hasProviderConfigured(p.id));
  return provider ? `${provider.envVar} 已设置` : '未检测到任何 API Key';
}
