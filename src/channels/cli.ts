import readline from 'readline';
import type { Channel, CLIConfig, ChannelResponse } from './types.js';
import type { Nanobot } from '../nanobot.js';
import { STREAM_EVENT_TEXT_DELTA, STREAM_EVENT_TEXT_COMPLETED, STREAM_EVENT_TOOL_STARTED, STREAM_EVENT_TOOL_COMPLETED, STREAM_EVENT_TOOL_FAILED, STREAM_EVENT_RUN_FAILED } from '../nanobot.js';
import { logger } from '../utils/logger.js';

export class CLIChannel implements Channel {
  id: string;
  name: string;
  private config: CLIConfig;
  private rl: readline.Interface | null = null;
  private history: string[] = [];
  private bot: Nanobot | null = null;
  private currentSessionKey: string = 'sdk:default';

  constructor(config: CLIConfig) {
    this.id = config.id;
    this.name = config.name;
    this.config = config;
  }

  async start(bot: Nanobot): Promise<void> {
    this.bot = bot;
    logger.info({ channel: this.id }, 'CLI channel started');
    
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      historySize: this.config.historySize || 100,
      prompt: this.config.prompt || 'nanobot> ',
    });

    console.log(`🐈 ${this.name} channel started`);
    console.log('Type "exit" or "quit" to exit');
    console.log('Type "help" for available commands');
    console.log('---');

    this.rl.on('line', async (input) => {
      const trimmed = input.trim();
      
      if (!trimmed) {
        this.rl!.prompt();
        return;
      }

      if (trimmed === 'exit' || trimmed === 'quit') {
        await this.stop();
        return;
      }

      if (trimmed === 'help') {
        this.showHelp();
        this.rl!.prompt();
        return;
      }

      if (trimmed === 'tools') {
        this.showTools();
        this.rl!.prompt();
        return;
      }

      if (trimmed === 'sessions') {
        await this.showSessions();
        this.rl!.prompt();
        return;
      }

      if (trimmed.startsWith('session ')) {
        const sessionKey = trimmed.slice(8).trim();
        await this.showSessionDetail(sessionKey);
        this.rl!.prompt();
        return;
      }

      if (trimmed.startsWith('use ')) {
        const sessionKey = trimmed.slice(4).trim();
        await this.switchSession(sessionKey);
        this.rl!.prompt();
        return;
      }

      await this.handleMessage(trimmed);
      this.rl!.prompt();
    });

    this.rl.on('close', async () => {
      await this.stop();
    });

    this.rl.prompt();
  }

  async stop(): Promise<void> {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
    if (this.bot) {
      await this.bot.close();
    }
    logger.info({ channel: this.id }, 'CLI channel stopped');
    console.log('\n🐈 Goodbye!');
    process.exit(0);
  }

  async sendMessage(chatId: string, content: string): Promise<ChannelResponse> {
    process.stdout.write(content);
    return { status: 'success' };
  }

  private async handleMessage(input: string): Promise<void> {
    if (!this.bot) return;

    this.addToHistory(input);
    let hasResponse = false;

    try {
      for await (const event of this.bot.stream(input, { channel: 'cli', sessionKey: this.currentSessionKey })) {
        switch (event.type) {
          case STREAM_EVENT_TEXT_DELTA:
            hasResponse = true;
            process.stdout.write(event.content || '');
            break;
          case STREAM_EVENT_TEXT_COMPLETED:
            hasResponse = true;
            process.stdout.write('\n');
            break;
          case STREAM_EVENT_TOOL_STARTED:
            console.log(`\n🔧 Running: ${event.tool_name}`);
            break;
          case STREAM_EVENT_TOOL_COMPLETED:
            console.log(`✅ ${event.tool_name} completed`);
            break;
          case STREAM_EVENT_TOOL_FAILED:
            console.log(`\n❌ ${event.tool_name} failed:`);
            console.log(`   ${event.content || event.error || 'Unknown error'}`);
            console.log(`   💡 Tip: Check your input parameters and try again`);
            break;
          case STREAM_EVENT_RUN_FAILED:
            console.log(`\n❌ Error occurred:`);
            console.log(`   ${event.error || 'Unknown error'}`);
            console.log('');
            console.log('💡 Troubleshooting tips:');
            console.log('   1. Check your API key configuration (OPENAI_API_KEY, GROQ_API_KEY, DEEPSEEK_API_KEY)');
            console.log('   2. Verify network connectivity');
            console.log('   3. Check log file for detailed error: .nanobot/logs/nanobot.log');
            break;
        }
      }

      if (!hasResponse) {
        console.log('\n(No response received)');
        console.log('');
        console.log('💡 Troubleshooting tips:');
        console.log('   1. Make sure you have configured API keys:');
        console.log('      export OPENAI_API_KEY="your-key"');
        console.log('      export GROQ_API_KEY="your-key"');
        console.log('      export DEEPSEEK_API_KEY="your-key"');
        console.log('   2. Check log file: .nanobot/logs/nanobot.log');
      }
    } catch (err) {
      logger.error({ err, input }, 'CLI message handling error');
      console.error('\n❌ Unexpected error:');
      console.error(`   ${(err as Error).message}`);
      console.error('');
      console.error('💡 Please check the log file for details: .nanobot/logs/nanobot.log');
    }
  }

  private addToHistory(input: string): void {
    this.history.push(input);
    if (this.history.length > (this.config.historySize || 100)) {
      this.history.shift();
    }
  }

  private showHelp(): void {
    console.log('\nAvailable commands:');
    console.log('  exit/quit - Exit the bot');
    console.log('  help - Show this help message');
    console.log('  tools - List available tools');
    console.log('  sessions - List active sessions');
    console.log('  session <key> - View detailed session information');
    console.log('  use <key> - Switch to another session (restore history)');
    console.log('  Any other input will be sent to the bot');
    console.log('');
  }

  private showTools(): void {
    if (!this.bot) return;
    const tools = this.bot.tools;
    console.log('\nAvailable tools:');
    tools.forEach((tool) => {
      console.log(`  - ${tool}`);
    });
    console.log('');
  }

  private async showSessions(): Promise<void> {
    if (!this.bot) return;
    const sessions = await this.bot.listSessions();
    console.log('\nActive sessions:');
    if (sessions.length === 0) {
      console.log('  (none)');
    } else {
      sessions.forEach((session) => {
        console.log(`  - ${session}`);
      });
    }
    console.log('');
    console.log('Use "session <key>" to view session details');
    console.log('');
  }

  private async showSessionDetail(sessionKey: string): Promise<void> {
    if (!this.bot) return;
    
    console.log(`\nSession: ${sessionKey}`);
    console.log('----------------------------------------');
    
    const detail = await this.bot.getSessionDetail(sessionKey);
    if (!detail) {
      console.log('Session not found');
      console.log('');
      return;
    }
    
    console.log(`Created: ${detail.createdAt}`);
    console.log(`Updated: ${detail.updatedAt}`);
    console.log('');
    
    if (detail.entries.length === 0) {
      console.log('No entries');
      console.log('');
      return;
    }
    
    for (const entry of detail.entries) {
      console.log(`[${entry.type}] ${entry.id.slice(-20)} (parent: ${entry.parentId?.slice(-20) || 'null'})`);
      console.log(`  Time: ${entry.timestamp}`);
      
      if (entry.provider) {
        console.log(`  Provider: ${entry.provider}`);
      }
      if (entry.modelId) {
        console.log(`  Model: ${entry.modelId}`);
      }
      if (entry.message) {
        console.log(`  Role: ${entry.message.role}`);
        if (entry.message.content) {
          console.log(`  Content: ${entry.message.content.slice(0, 100)}${entry.message.content.length > 100 ? '...' : ''}`);
        }
      }
      if (entry.toolName) {
        console.log(`  Tool: ${entry.toolName}`);
      }
      if (entry.toolCallId) {
        console.log(`  ToolCallId: ${entry.toolCallId}`);
      }
      if (entry.input) {
        console.log(`  Input: ${JSON.stringify(entry.input)}`);
      }
      if (entry.content) {
        console.log(`  Content: ${entry.content.slice(0, 100)}${entry.content.length > 100 ? '...' : ''}`);
      }
      if (entry.isError !== undefined) {
        console.log(`  IsError: ${entry.isError}`);
      }
      if (entry.usage) {
        console.log(`  Usage: input=${entry.usage.input || 0}, output=${entry.usage.output || 0}, total=${entry.usage.total || 0}`);
      }
      console.log('');
    }
  }

  private async switchSession(sessionKey: string): Promise<void> {
    if (!this.bot) return;
    
    const sessions = await this.bot.listSessions();
    if (!sessions.includes(sessionKey)) {
      console.log(`\nSession "${sessionKey}" not found.`);
      console.log('Available sessions:');
      sessions.forEach(s => console.log(`  - ${s}`));
      console.log('');
      return;
    }
    
    this.currentSessionKey = sessionKey;
    console.log(`\nSwitched to session: ${sessionKey}`);
    
    // Show session info
    const detail = await this.bot.getSessionDetail(sessionKey);
    if (detail && detail.entries.length > 0) {
      const messageEntries = detail.entries.filter(e => e.type === 'message') as any[];
      const lastMessage = messageEntries[messageEntries.length - 1];
      if (lastMessage && lastMessage.message) {
        console.log(`Last message: ${lastMessage.message.role === 'user' ? 'You:' : 'Bot:'} ${lastMessage.message.content?.slice(0, 50)}${lastMessage.message.content?.length > 50 ? '...' : ''}`);
      }
      console.log(`Total messages: ${messageEntries.length}`);
    }
    console.log('');
  }
}

export function createCLIChannel(config: CLIConfig): CLIChannel {
  return new CLIChannel(config);
}
