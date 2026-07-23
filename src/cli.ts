#!/usr/bin/env node

import { Kobot } from './kobot';
import { CLIChannel } from './channels/cli';
import { createLogger } from './utils/logger';
import { hasAnyApiKey, loadEnvFile, runSetupWizard } from './setup-wizard';

async function main(): Promise<void> {
  console.log('🐈 Starting Kobot...');
  
  // 在机器人初始化前禁用 CLI 模式下的控制台日志
  process.env.KOBOT_LOG_CONSOLE = 'false';
  createLogger({ console_enabled: false });

  // 从 ~/.kobot/.env 加载持久化的环境变量（shell 环境变量优先）
  loadEnvFile();

  // 如果未配置 API Key，运行交互式设置向导
  let selectedModel: string | undefined;
  if (!hasAnyApiKey()) {
    const setupResult = await runSetupWizard();
    selectedModel = setupResult.model;
  } else {
    // 也支持 KOBOT_MODEL 环境变量
    if (process.env.KOBOT_MODEL) {
      selectedModel = process.env.KOBOT_MODEL;
    }
  }
  
  try {
    const bot = await Kobot.fromConfig({ model: selectedModel });
    
    console.log('✅ Kobot initialized successfully');
    console.log(`   Model: ${bot.config_.agents.defaults.model}`);
    console.log(`   Tools: ${bot.tools.length} available`);
    
    const cliChannel = new CLIChannel({
      id: 'cli',
      name: 'CLI',
      enabled: true,
      historySize: 100,
      prompt: 'kobot> ',
    });

    await cliChannel.start(bot);
  } catch (err) {
    console.error('❌ Error starting kobot:', (err as Error).message);
    console.log('\n💡 Tips:');
    console.log('   - Make sure you have configured API keys in environment variables');
    console.log('   - OPENAI_API_KEY, ANTHROPIC_API_KEY, GROQ_API_KEY, etc.');
    console.log('   - Check your config file at ~/.kobot/config.yaml');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
