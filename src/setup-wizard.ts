import fs from 'fs';
import path from 'path';
import os from 'os';
import readline from 'readline';

const DOTENV_PATH = path.join(os.homedir(), '.nanobot', '.env');

// 已知的 API Key 环境变量（来自 pi-ai 的 env-api-keys.js）
const ALL_API_KEY_ENV_VARS = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_OAUTH_TOKEN',
  'DEEPSEEK_API_KEY',
  'GROQ_API_KEY',
  'GEMINI_API_KEY',
  'MISTRAL_API_KEY',
  'CEREBRAS_API_KEY',
  'XAI_API_KEY',
  'OPENROUTER_API_KEY',
  'TOGETHER_API_KEY',
  'FIREWORKS_API_KEY',
  'HF_TOKEN',
  'NVIDIA_API_KEY',
  'MINIMAX_API_KEY',
  'MOONSHOT_API_KEY',
  'KIMI_API_KEY',
  'ZAI_API_KEY',
  'OPENCODE_API_KEY',
  'CLOUDFLARE_API_KEY',
];

interface ProviderOption {
  id: string;
  name: string;
  envVar: string;
  models: string[];
  description: string;
  website: string;
  apiUrl?: string;
}

const POPULAR_PROVIDERS: ProviderOption[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    envVar: 'DEEPSEEK_API_KEY',
    models: ['deepseek-v4-flash'],
    description: '高性价比，速度快，支持超长上下文 (1M tokens)',
    website: 'https://platform.deepseek.com/api_keys',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    envVar: 'OPENAI_API_KEY',
    models: ['gpt-4o-mini'],
    description: '最广泛兼容，支持多模态',
    website: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'anthropic',
    name: 'Anthropic (Claude)',
    envVar: 'ANTHROPIC_API_KEY',
    models: ['claude-sonnet-4-20250514'],
    description: '擅长复杂推理和编程',
    website: 'https://console.anthropic.com/settings/keys',
  },
  {
    id: 'groq',
    name: 'Groq',
    envVar: 'GROQ_API_KEY',
    models: ['llama-3.3-70b-versatile'],
    description: '免费额度可用，推理速度极快',
    website: 'https://console.groq.com/keys',
  },
  {
    id: 'google',
    name: 'Google Gemini',
    envVar: 'GEMINI_API_KEY',
    models: ['gemini-2.0-flash'],
    description: '免费额度可用，多模态能力强',
    website: 'https://aistudio.google.com/apikey',
  },
];

/**
 * 检查是否有任何已知的 API Key 环境变量已设置。
 */
export function hasAnyApiKey(): boolean {
  return ALL_API_KEY_ENV_VARS.some(envVar => !!process.env[envVar]);
}

export interface SetupResult {
  provider: string;
  envVar: string;
  model: string;
}

function question(rl: readline.Interface, query: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(query, resolve);
  });
}

/**
 * 将环境变量持久化到 ~/.nanobot/.env 文件中，以便重启后仍然有效。
 */
function saveEnvFile(envVars: Record<string, string>): void {
  const dir = path.dirname(DOTENV_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // 读取已有的 .env 文件以保留无关变量
  const existing: Record<string, string> = {};
  if (fs.existsSync(DOTENV_PATH)) {
    const content = fs.readFileSync(DOTENV_PATH, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      existing[key] = val;
    }
  }

  // 合并新变量
  const merged = { ...existing, ...envVars };

  const lines = Object.entries(merged).map(([k, v]) => `${k}=${v}`);
  fs.writeFileSync(DOTENV_PATH, lines.join('\n') + '\n', 'utf-8');
  console.log(`💾 配置已保存到 ${DOTENV_PATH}`);
}

/**
 * 从 ~/.nanobot/.env 加载环境变量到 process.env。
 */
export function loadEnvFile(): void {
  if (!fs.existsSync(DOTENV_PATH)) return;
  try {
    const content = fs.readFileSync(DOTENV_PATH, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      // 不覆盖已有的环境变量（用户的 shell 环境优先）
      if (!(key in process.env)) {
        process.env[key] = val;
      }
    }
  } catch {
    // 静默忽略 .env 加载错误
  }
}

/**
 * 运行交互式设置向导，让用户：
 * 1. 选择模型提供商
 * 2. 输入 API Key
 * 3. 确认选择
 *
 * 返回所选提供商、环境变量和模型名称。
 */
export async function runSetupWizard(): Promise<SetupResult> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    console.log('');
    console.log('╔══════════════════════════════════════════════╗');
    console.log('║   🔑 Nanobot 首次设置 - 模型配置向导        ║');
    console.log('╚══════════════════════════════════════════════╝');
    console.log('');
    console.log('未检测到 API Key 环境变量。');
    console.log('选择一个模型提供商并输入 API Key 即可快速开始。');
    console.log('');

    const provider = await selectProvider(rl);
    const apiKey = await inputApiKey(rl, provider);
    const model = provider.models[0];

    // 为当前会话设置环境变量
    process.env[provider.envVar] = apiKey;
    process.env.NANOBOT_MODEL = model;

    // 持久化到 ~/.nanobot/.env 供以后使用
    const envVars: Record<string, string> = {
      [provider.envVar]: apiKey,
      NANOBOT_MODEL: model,
    };
    if (provider.apiUrl) {
      envVars.NANOBOT_API_BASE = provider.apiUrl;
    }

    console.log(`\n✅ 已设置 ${provider.envVar}`);
    console.log(`✅ 已设置默认模型: ${model}`);
    saveEnvFile(envVars);
    console.log('');

    return {
      provider: provider.id,
      envVar: provider.envVar,
      model,
    };
  } finally {
    rl.close();
  }
}

async function selectProvider(rl: readline.Interface): Promise<ProviderOption> {
  console.log('可用的模型提供商：');
  console.log('');

  POPULAR_PROVIDERS.forEach((p, i) => {
    console.log(`  ${i + 1}. ${p.name}`);
    console.log(`     ${p.description}`);
    console.log(`     推荐模型: ${p.models[0]}`);
    console.log(`     获取 API Key: ${p.website}`);
    console.log('');
  });
  console.log('  c. 自定义提供商 (Custom) - 使用兼容 OpenAI API 的任意服务');
  console.log('  0. 退出');

  while (true) {
    const answer = await question(rl, '\n请选择 (1-5 / c / 0): ');
    const trimmed = answer.trim().toLowerCase();

    if (trimmed === '0') {
      console.log('\n已退出。配置 API Key 后重新启动即可。');
      console.log('支持的環境變量示例:');
      POPULAR_PROVIDERS.forEach(p => {
        console.log(`  export ${p.envVar}="your-api-key"`);
      });
      process.exit(0);
    }

    if (trimmed === 'c') {
      return await selectCustomProvider(rl);
    }

    const choice = parseInt(trimmed, 10);
    if (!isNaN(choice) && choice >= 1 && choice <= POPULAR_PROVIDERS.length) {
      return POPULAR_PROVIDERS[choice - 1];
    }

    console.log('❌ 无效选择，请输入 1-5、c 或 0。');
  }
}

async function selectCustomProvider(rl: readline.Interface): Promise<ProviderOption> {
  console.log('\n--- 自定义提供商 ---');
  console.log('输入兼容 OpenAI API 的服务信息:');

  const name = await question(rl, '  提供商名称 (如 MyProvider): ');
  if (!name.trim()) {
    console.log('❌ 名称不能为空，返回上级菜单。\n');
    return selectProvider(rl);
  }

  const apiUrl = await question(rl, '  API Base URL (如 https://api.example.com/v1): ');
  if (!apiUrl.trim()) {
    console.log('❌ URL 不能为空，返回上级菜单。\n');
    return selectProvider(rl);
  }

  const modelName = await question(rl, '  模型名称 (如 gpt-4o-mini): ');
  if (!modelName.trim()) {
    console.log('❌ 模型名称不能为空，返回上级菜单。\n');
    return selectProvider(rl);
  }

  return {
    id: 'custom',
    name: name.trim(),
    envVar: 'CUSTOM_API_KEY',
    models: [modelName.trim()],
    apiUrl: apiUrl.trim(),
    description: `自定义: ${apiUrl.trim()}`,
    website: apiUrl.trim(),
  };
}

async function inputApiKey(rl: readline.Interface, provider: ProviderOption): Promise<string> {
  while (true) {
    const key = await question(rl, `请输入 ${provider.name} API Key: `);
    const trimmed = key.trim();

    if (trimmed.length < 8) {
      console.log('❌ API Key 太短 (需要至少 8 个字符)，请重新输入。');
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
