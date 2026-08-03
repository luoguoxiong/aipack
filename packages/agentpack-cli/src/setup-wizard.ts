/**
 * packages/agentpack-cli/src/setup-wizard.ts
 *
 * 首次设置向导：未检测到 API Key 时引导用户
 *   1. 选择模型提供商（来自 agentpack 内置目录）
 *   2. 输入 API Key
 *   3. 选择模型
 *   4. 保存到 ~/.agentpack/.env 并写入 process.env
 *
 * 参考 src/setup-wizard.ts（kobot）的交互风格，适配 agentpack 内置提供商/模型。
 */

import readline from 'readline';
import {
  getBuiltinModels,
  getBuiltinProviders,
  getEnvApiKey,
} from 'agentpack/ai';
import type { Model as AiModel } from 'agentpack/ai';
import { saveEnvFile } from './env';

/** 向导结果：选择的提供商与模型 */
export interface SetupResult {
  provider: string;
  model: string;
}

/** 是否有任一内置提供商已配置 API Key */
export function hasAnyApiKey(): boolean {
  return getBuiltinProviders().some((p) => !!getEnvApiKey(p.id));
}

function question(rl: readline.Interface, query: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(query, resolve);
  });
}

/**
 * 运行交互式设置向导。
 * 保存 API Key 到用户级 .env 并写入 process.env，返回所选提供商与模型。
 */
export async function runSetupWizard(): Promise<SetupResult> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    console.log('');
    console.log('╔══════════════════════════════════════════════╗');
    console.log('║   🔑 agentpack 首次设置 - 模型配置向导      ║');
    console.log('╚══════════════════════════════════════════════╝');
    console.log('');
    console.log('未检测到 API Key 环境变量。');
    console.log('选择一个模型提供商并输入 API Key 即可快速开始。');
    console.log('');

    const provider = await selectProvider(rl);
    const apiKey = await inputApiKey(rl, provider);
    const model = await selectModel(rl, provider);

    // 写入当前进程（后续初始化立即可用）
    process.env[provider.envVar] = apiKey;
    process.env.AGENTPACK_PROVIDER = provider.id;
    process.env.AGENTPACK_MODEL = model.id;

    // 持久化到用户级 .env，供以后启动使用
    const envPath = saveEnvFile({
      [provider.envVar]: apiKey,
      AGENTPACK_PROVIDER: provider.id,
      AGENTPACK_MODEL: model.id,
    });

    console.log(`\n✅ 已设置 ${provider.envVar}`);
    console.log(`✅ 已设置默认模型: ${provider.id}/${model.id}`);
    console.log(`💾 配置已保存到 ${envPath}`);
    console.log('');

    return { provider: provider.id, model: model.id };
  } finally {
    rl.close();
  }
}

// ─── 提供商选择 ────────────────────────────────────────────────────

interface WizardProvider {
  id: string;
  name: string;
  envVar: string;
  models: AiModel[];
}

function listWizardProviders(): WizardProvider[] {
  const meta = new Map(
    getBuiltinProviders().map((p) => [p.id, { name: p.name, envVar: p.envVar }]),
  );
  const byProvider = new Map<string, AiModel[]>();
  for (const m of getBuiltinModels()) {
    if (!byProvider.has(m.provider)) byProvider.set(m.provider, []);
    byProvider.get(m.provider)!.push(m);
  }

  return [...byProvider.entries()]
    .map(([id, models]) => ({
      id,
      name: meta.get(id)?.name ?? id,
      envVar: meta.get(id)?.envVar ?? `${id.toUpperCase()}_API_KEY`,
      models,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function selectProvider(rl: readline.Interface): Promise<WizardProvider> {
  const providers = listWizardProviders();

  console.log('可用的模型提供商：');
  console.log('');
  providers.forEach((p, i) => {
    console.log(`  ${i + 1}. ${p.name} (${p.id})`);
    console.log(`     推荐模型: ${p.models[0]?.id}`);
    console.log(`     模型数量: ${p.models.length}`);
    console.log('');
  });
  console.log('  0. 退出');

  while (true) {
    const answer = await question(rl, '\n请选择 (1-N / 0): ');
    const trimmed = answer.trim().toLowerCase();

    if (trimmed === '0') {
      console.log('\n已退出。配置 API Key 后重新启动即可。');
      process.exit(0);
    }

    const choice = parseInt(trimmed, 10);
    if (!isNaN(choice) && choice >= 1 && choice <= providers.length) {
      return providers[choice - 1];
    }

    console.log('❌ 无效选择，请重试。');
  }
}

async function inputApiKey(
  rl: readline.Interface,
  provider: WizardProvider,
): Promise<string> {
  while (true) {
    const key = await question(rl, `请输入 ${provider.name} API Key: `);
    const trimmed = key.trim();

    if (trimmed.length < 8) {
      console.log('❌ API Key 太短（需要至少 8 个字符），请重新输入。');
      continue;
    }

    // 确认
    const confirm = await question(rl, `确认已设置 API Key (y/N): `);
    if (confirm.trim().toLowerCase() === 'y') {
      return trimmed;
    }

    console.log('请重新输入。');
  }
}

async function selectModel(
  rl: readline.Interface,
  provider: WizardProvider,
): Promise<AiModel> {
  console.log(`\n${provider.name} 可用模型：`);
  console.log('');
  provider.models.forEach((m, i) => {
    console.log(`  ${i + 1}. ${m.id}${m.name ? ` - ${m.name}` : ''}`);
  });

  while (true) {
    const answer = await question(rl, `\n请选择模型 (1-${provider.models.length}): `);
    const trimmed = answer.trim();

    const choice = parseInt(trimmed, 10);
    if (!isNaN(choice) && choice >= 1 && choice <= provider.models.length) {
      return provider.models[choice - 1];
    }

    console.log('❌ 无效选择，请重试。');
  }
}
