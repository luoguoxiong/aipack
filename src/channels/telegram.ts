import { logger } from '../utils/logger.js';
import { MessageBus } from '../bus/queue.js';
import { BaseChannel, ChannelConfig, SendOptions } from './base.js';

export interface TelegramChannelConfig extends ChannelConfig {
  bot_token?: string;
  webhook_url?: string;
  polling?: boolean;
}

export class TelegramChannel extends BaseChannel {
  name = 'telegram';
  private pollingInterval?: NodeJS.Timeout;
  private lastUpdateId = 0;
  private apiBase = 'https://api.telegram.org';

  protected get telegramConfig(): TelegramChannelConfig {
    return this.config as TelegramChannelConfig;
  }

  constructor(bus: MessageBus, config: TelegramChannelConfig) {
    super(bus, config);
    this.name = config.name || 'telegram';
  }

  async start(): Promise<void> {
    if (this.running) return;

    if (!this.telegramConfig.bot_token) {
      logger.warn('Telegram bot_token not configured, channel disabled');
      return;
    }

    this.subscribeToOutbound();
    this.subscribeToStream();

    if (this.telegramConfig.polling !== false) {
      this.startPolling();
    }

    this.running = true;
    logger.info('Telegram channel started');
  }

  async stop(): Promise<void> {
    if (!this.running) return;

    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = undefined;
    }

    this.unsubscribeAll();
    this.running = false;
    logger.info('Telegram channel stopped');
  }

  async send(chatId: string, text: string, options?: SendOptions): Promise<void> {
    try {
      await this.apiRequest('sendMessage', {
        chat_id: chatId,
        text,
        parse_mode: 'Markdown',
        reply_to_message_id: options?.reply_to,
      });
    } catch (err) {
      logger.error({ err, chat_id: chatId }, 'Failed to send Telegram message');
      try {
        await this.apiRequest('sendMessage', {
          chat_id: chatId,
          text,
        });
      } catch (err2) {
        logger.error({ err: err2 }, 'Failed to send plain text message');
      }
    }
  }

  async sendDelta(_chatId: string, _delta: string, _options?: SendOptions): Promise<void> {
  }

  private async apiRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    const url = `${this.apiBase}/bot${this.telegramConfig.bot_token}/${method}`;
    const { default: axios } = await import('axios');
    
    const response = await axios.post(url, params, { timeout: 30000 });
    return response.data;
  }

  private startPolling(): void {
    this.pollingInterval = setInterval(() => {
      this.pollUpdates().catch(err => {
        logger.error({ err }, 'Telegram polling error');
      });
    }, 2000);
  }

  private async pollUpdates(): Promise<void> {
    try {
      const data = await this.apiRequest('getUpdates', {
        offset: this.lastUpdateId + 1,
        timeout: 30,
        allowed_updates: ['message'],
      }) as { ok: boolean; result: Array<{ update_id: number; message?: { chat: { id: number }; from: { id: number; first_name: string }; text?: string } }> };

      if (!data.ok) return;

      for (const update of data.result) {
        this.lastUpdateId = update.update_id;
        
        if (update.message && update.message.text) {
          this.publishInbound({
            chat_id: String(update.message.chat.id),
            sender_id: String(update.message.from.id),
            sender_name: update.message.from.first_name,
            text: update.message.text,
          });
        }
      }
    } catch (err) {
      logger.debug({ err }, 'Telegram poll error');
    }
  }
}
