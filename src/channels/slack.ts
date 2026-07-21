import { logger } from '../utils/logger.js';
import { MessageBus } from '../bus/queue.js';
import { BaseChannel, ChannelConfig, SendOptions } from './base.js';

export interface SlackChannelConfig extends ChannelConfig {
  bot_token?: string;
  signing_secret?: string;
  app_token?: string;
  socket_mode?: boolean;
}

export class SlackChannel extends BaseChannel {
  name = 'slack';
  private app: unknown = null;

  protected get slackConfig(): SlackChannelConfig {
    return this.config as SlackChannelConfig;
  }

  constructor(bus: MessageBus, config: SlackChannelConfig) {
    super(bus, config);
    this.name = config.name || 'slack';
  }

  async start(): Promise<void> {
    if (this.running) return;

    if (!this.slackConfig.bot_token) {
      logger.warn('Slack bot_token not configured, channel disabled');
      return;
    }

    try {
      // @ts-ignore - @slack/bolt is an optional dependency
      const { App } = await import('@slack/bolt');
      
      this.app = new App({
        token: this.slackConfig.bot_token,
        signingSecret: this.slackConfig.signing_secret,
        appToken: this.slackConfig.app_token,
        socketMode: this.slackConfig.socket_mode !== false,
      });

      const app = this.app as {
        message: (pattern: string, handler: (args: { message: { channel: string; user: string; text: string } }) => Promise<void>) => void;
        client: { chat: { postMessage: (params: { channel: string; text: string }) => Promise<unknown> } };
        start: (port?: number) => Promise<void>;
      };

      app.message('', async ({ message }) => {
        this.publishInbound({
          chat_id: message.channel,
          sender_id: message.user,
          text: message.text,
        });
      });

      await app.start();
      
      this.subscribeToOutbound();
      this.running = true;
      logger.info('Slack channel started');
    } catch (err) {
      logger.error({ err }, 'Failed to start Slack channel');
    }
  }

  async stop(): Promise<void> {
    if (!this.running) return;

    try {
      const app = this.app as { stop: () => Promise<void> };
      await app?.stop();
    } catch (err) {
      logger.error({ err }, 'Error stopping Slack channel');
    }

    this.unsubscribeAll();
    this.app = null;
    this.running = false;
    logger.info('Slack channel stopped');
  }

  async send(chatId: string, text: string, _options?: SendOptions): Promise<void> {
    try {
      const app = this.app as {
        client: { chat: { postMessage: (params: { channel: string; text: string }) => Promise<unknown> } };
      };
      await app.client.chat.postMessage({
        channel: chatId,
        text,
      });
    } catch (err) {
      logger.error({ err, chat_id: chatId }, 'Failed to send Slack message');
    }
  }

  async sendDelta(_chatId: string, _delta: string, _options?: SendOptions): Promise<void> {
  }
}
