import readline from 'readline';
import { logger } from '../utils/logger.js';
import { loadConfig, saveConfig, getConfigPath } from '../config/loader.js';
import { defaultConfig } from '../config/schema.js';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question: string): Promise<string> {
  return new Promise(resolve => {
    rl.question(question, resolve);
  });
}

export async function runOnboard(): Promise<void> {
  try {
    console.log('Welcome to nanobot setup!\n');
    console.log('Let\'s configure your AI assistant.\n');

    const configPath = getConfigPath();
    const fs = await import('fs');
    
    try {
      await fs.promises.access(configPath);
      const overwrite = await ask('Config already exists. Overwrite? (y/N): ');
      if (!overwrite.toLowerCase().startsWith('y')) {
        console.log('Setup cancelled.');
        rl.close();
        return;
      }
    } catch {
      // Config doesn't exist
    }

    const config = defaultConfig();

    console.log('\n=== Model Configuration ===');
    const model = await ask('Enter your default model name: ');
    if (model.trim()) {
      config.agents.defaults.model = model.trim();
    }

    const provider = await ask('Enter provider name (auto/openai/anthropic, default: auto): ');
    if (provider.trim()) {
      config.agents.defaults.provider = provider.trim();
    }

    const apiKey = await ask('Enter API key (leave blank to set later): ');
    if (apiKey.trim()) {
      if (!config.providers.items) {
        config.providers.items = [];
      }
      config.providers.items.push({
        name: config.agents.defaults.provider || 'auto',
        api_key: apiKey.trim(),
        extra_headers: {},
        extra_query: {},
        extra_body: {},
      });
    }

    console.log('\n=== Workspace Configuration ===');
    const workspace = await ask('Enter default workspace directory (default: current directory): ');
    if (workspace.trim()) {
      config.agents.defaults.workspace = workspace.trim();
    }

    console.log('\n=== Timezone ===');
    const timezone = await ask('Enter timezone (default: UTC): ');
    if (timezone.trim()) {
      config.agents.defaults.timezone = timezone.trim();
    }

    await saveConfig(config);
    console.log(`\n✅ Config saved to ${configPath}`);
    console.log('\nSetup complete! You can now run nanobot.');

    rl.close();
  } catch (err) {
    logger.error({ err }, 'Onboard setup failed');
    rl.close();
    process.exit(1);
  }
}