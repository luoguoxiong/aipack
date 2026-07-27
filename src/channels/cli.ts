import readline from 'readline';
import type { Channel, CLIConfig, ChannelResponse } from './types';
import type { Kobot } from '../kobot';
import { STREAM_EVENT_TEXT_DELTA, STREAM_EVENT_TEXT_COMPLETED, STREAM_EVENT_TOOL_STARTED, STREAM_EVENT_TOOL_COMPLETED, STREAM_EVENT_TOOL_FAILED, STREAM_EVENT_RUN_FAILED } from '../kobot';
import { logger } from '../utils/logger';

export class CLIChannel implements Channel {
  id: string;
  name: string;
  private config: CLIConfig;
  private rl: readline.Interface | null = null;
  private history: string[] = [];
  private bot: Kobot | null = null;
  private currentSessionKey: string;

  constructor(config: CLIConfig) {
    this.id = config.id;
    this.name = config.name;
    this.config = config;
    // 生成唯一的 session key，格式：cli_YYYYMMDD_HHMMSS
    const now = new Date();
    const timestamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 15);
    this.currentSessionKey = `cli_${timestamp}`;
  }

  async start(bot: Kobot): Promise<void> {
    this.bot = bot;
    logger.info({ channel: this.id }, 'CLI 频道已启动');
    
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      historySize: this.config.historySize || 100,
      prompt: this.config.prompt || 'kobot> ',
    });

    console.log(`[${this.name}] 频道已启动`);
    console.log(`Session: ${this.currentSessionKey}`);
    console.log('输入 "exit" 或 "quit" 退出');
    console.log('输入 "help" 查看可用命令');
    console.log('输入 "sessions" 查看历史会话');
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

      if (trimmed.startsWith('replay ')) {
        const sessionKey = trimmed.slice(7).trim();
        await this.replaySession(sessionKey);
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
    logger.info({ channel: this.id }, 'CLI 频道已停止');
    console.log('\n再见！');
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
            console.log(`\n🔧 正在运行：${event.tool_name}`);
            break;
          case STREAM_EVENT_TOOL_COMPLETED:
            console.log(`✅ ${event.tool_name} 完成`);
            break;
          case STREAM_EVENT_TOOL_FAILED:
            console.log(`\n❌ ${event.tool_name} 失败：`);
            console.log(`   ${event.content || event.error || '未知错误'}`);
            console.log(`   💡 提示：请检查输入参数并重试`);
            break;
          case STREAM_EVENT_RUN_FAILED:
            console.log(`\n❌ 发生错误：`);
            console.log(`   ${event.error || '未知错误'}`);
            console.log('');
            console.log('💡 故障排除提示：');
            console.log('   1. 检查您的 API Key 配置（OPENAI_API_KEY、GROQ_API_KEY、DEEPSEEK_API_KEY）');
            console.log('   2. 验证网络连接');
            console.log('   3. 查看日志文件了解详细错误（请参阅配置中的 logging.file_path）');
            break;
        }
      }

      if (!hasResponse) {
        console.log('\n（未收到响应）');
        console.log('');
        console.log('💡 故障排除提示：');
        console.log('   1. 确保已配置 API Key：');
        console.log('      export OPENAI_API_KEY="your-key"');
        console.log('      export GROQ_API_KEY="your-key"');
        console.log('      export DEEPSEEK_API_KEY="your-key"');
        console.log('   2. 查看日志文件（请参阅配置中的 logging.file_path）');
      }
    } catch (err) {
      logger.error({ err, input }, 'CLI 消息处理错误');
      console.error('\n❌ 意外错误：');
      console.error(`   ${(err as Error).message}`);
      console.error('');
      console.error('💡 请查看日志文件了解详情（请参阅配置中的 logging.file_path）');
    }
  }

  private addToHistory(input: string): void {
    this.history.push(input);
    if (this.history.length > (this.config.historySize || 100)) {
      this.history.shift();
    }
  }

  private showHelp(): void {
    console.log('\n可用命令：');
    console.log('  exit/quit - 退出机器人');
    console.log('  help - 显示此帮助信息');
    console.log('  tools - 列出可用工具');
    console.log('  sessions - 列出活动会话');
    console.log('  session <key> - 查看详细会话信息');
    console.log('  use <key> - 切换到另一个会话（恢复历史记录）');
    console.log('  replay <key> - 回放历史会话以复现问题');
    console.log('  任何其他输入将发送给机器人');
    console.log('');
  }

  private showTools(): void {
    if (!this.bot) return;
    const tools = this.bot.tools;
    console.log('\n可用工具：');
    tools.forEach((tool) => {
      console.log(`  - ${tool}`);
    });
    console.log('');
  }

  private async showSessions(): Promise<void> {
    if (!this.bot) return;
    const sessions = await this.bot.listSessions();
    console.log('\n活动会话：');
    if (sessions.length === 0) {
      console.log('  （无）');
    } else {
      sessions.forEach((session) => {
        console.log(`  - ${session}`);
      });
    }
    console.log('');
    console.log('使用 "session <key>" 查看会话详情');
    console.log('');
  }

  private async showSessionDetail(sessionKey: string): Promise<void> {
    if (!this.bot) return;
    
    console.log(`\n会话：${sessionKey}`);
    console.log('----------------------------------------');
    
    const detail = await this.bot.getSessionDetail(sessionKey);
    if (!detail) {
      console.log('会话未找到');
      console.log('');
      return;
    }
    
    console.log(`创建时间：${detail.createdAt}`);
    console.log(`更新时间：${detail.updatedAt}`);
    console.log('');
    
    if (detail.entries.length === 0) {
      console.log('无条目');
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
      console.log(`\n会话「${sessionKey}」未找到。`);
      console.log('可用会话：');
      sessions.forEach(s => console.log(`  - ${s}`));
      console.log('');
      return;
    }
    
    this.currentSessionKey = sessionKey;
    console.log(`\n已切换到会话：${sessionKey}`);
    
    // 显示会话信息
    const detail = await this.bot.getSessionDetail(sessionKey);
    if (detail && detail.entries.length > 0) {
      const messageEntries = detail.entries.filter(e => e.type === 'message') as any[];
      const lastMessage = messageEntries[messageEntries.length - 1];
      if (lastMessage && lastMessage.message) {
        console.log(`最后消息：${lastMessage.message.role === 'user' ? '你：' : '机器人：'} ${lastMessage.message.content?.slice(0, 50)}${lastMessage.message.content?.length > 50 ? '...' : ''}`);
      }
      console.log(`消息总数：${messageEntries.length}`);
    }
    console.log('');
  }

  private async replaySession(sessionKey: string): Promise<void> {
    if (!this.bot) return;

    console.log(`\n开始回放会话：${sessionKey}`);
    console.log('----------------------------------------');

    try {
      const result = await this.bot.replaySession(sessionKey,
        // 每轮开始前显示进度
        (current, total, message) => {
          console.log(`[${current}/${total}] 正在回放：${message.slice(0, 80)}${message.length > 80 ? '...' : ''}`);
        },
        // 每轮完成后立即显示结果
        (current, total, turn) => {
          if (turn.error) {
            console.log(`  ❌ 错误：${turn.error}`);
          } else if (turn.response) {
            const preview = turn.response.slice(0, 300);
            console.log(`  🤖 响应：${preview}${turn.response.length > 300 ? '...' : ''}`);
          } else {
            console.log('  ⚠️  无响应');
          }
          console.log('');
        },
      );

      console.log(`共 ${result.userMessageCount} 条用户消息，用时 ${(result.totalDurationMs / 1000).toFixed(1)}s`);

      if (result.totalErrors > 0) {
        console.log(`💥 总计 ${result.totalErrors}/${result.userMessageCount} 轮出错`);
      } else {
        console.log('✅ 全部回放成功，未出现错误');
      }
    } catch (err) {
      console.log(`\n❌ 回放失败：${(err as Error).message}`);
    }
    console.log('');
  }
}

export function createCLIChannel(config: CLIConfig): CLIChannel {
  return new CLIChannel(config);
}
