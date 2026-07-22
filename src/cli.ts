#!/usr/bin/env node

import { Nanobot } from './nanobot.js';
import { CLIChannel } from './channels/cli.js';

async function main(): Promise<void> {
  console.log('🐈 Starting Nanobot...');
  
  try {
    const bot = await Nanobot.fromConfig();
    
    console.log('✅ Nanobot initialized successfully');
    console.log(`   Model: ${bot.config_.agents.defaults.model}`);
    console.log(`   Tools: ${bot.tools.length} available`);
    
    const cliChannel = new CLIChannel({
      id: 'cli',
      name: 'CLI',
      enabled: true,
      historySize: 100,
      prompt: 'nanobot> ',
    });

    await cliChannel.start(bot);
  } catch (err) {
    console.error('❌ Error starting nanobot:', (err as Error).message);
    console.log('\n💡 Tips:');
    console.log('   - Make sure you have configured API keys in environment variables');
    console.log('   - OPENAI_API_KEY, ANTHROPIC_API_KEY, GROQ_API_KEY, etc.');
    console.log('   - Check your config file at ~/.nanobot/config.yaml');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
