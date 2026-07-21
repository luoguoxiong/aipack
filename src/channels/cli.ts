import readline from 'readline';
import { logger } from '../utils/logger.js';
import { MessageBus } from '../bus/queue.js';
import { BaseChannel, ChannelConfig, SendOptions } from './base.js';

export class CliChannel extends BaseChannel {
  name = 'cli';
  private rl?: readline.Interface;
  private messageBuffer: string[] = [];
  private waitingForInput = false;

  constructor(bus: MessageBus, config?: ChannelConfig) {
    super(bus, config || { name: 'cli' });
  }

  async start(): Promise<void> {
    if (this.running) return;

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: '> ',
    });

    this.rl.on('line', async (line) => {
      const text = line.trim();
      if (!text) {
        this.rl?.prompt();
        return;
      }

      if (text === '/exit' || text === '/quit') {
        this.stop();
        process.exit(0);
        return;
      }

      this.publishInbound({
        chat_id: 'cli',
        sender_id: 'user',
        text,
      });
    });

    this.rl.on('close', () => {
      this.running = false;
      logger.info('CLI channel closed');
    });

    this.subscribeToOutbound();
    this.subscribeToStream();

    this.running = true;
    this.rl.prompt();
    logger.info('CLI channel started');
  }

  async stop(): Promise<void> {
    if (!this.running) return;

    this.unsubscribeAll();
    this.rl?.close();
    this.running = false;
  }

  async send(_chatId: string, text: string, _options?: SendOptions): Promise<void> {
    if (this.rl) {
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0);
      console.log(`${text}`);
      this.rl.prompt();
    } else {
      console.log(text);
    }
  }

  async sendDelta(_chatId: string, delta: string, _options?: SendOptions): Promise<void> {
    process.stdout.write(delta);
  }

  async readLine(prompt = '> '): Promise<string> {
    return new Promise((resolve) => {
      if (this.rl) {
        this.rl.question(prompt, (answer) => {
          resolve(answer.trim());
        });
      } else {
        resolve('');
      }
    });
  }
}
