import { logger } from '../utils/logger.js';
import { MessageBus } from '../bus/queue.js';
import { BaseChannel, ChannelConfig, SendOptions } from './base.js';

export interface DiscordChannelConfig extends ChannelConfig {
  token?: string;
  intents?: number;
}

export class DiscordChannel extends BaseChannel {
  name = 'discord';
  private client: unknown = null;

  protected get discordConfig(): DiscordChannelConfig {
    return this.config as DiscordChannelConfig;
  }

  constructor(bus: MessageBus, config: DiscordChannelConfig) {
    super(bus, config);
    this.name = config.name || 'discord';
  }

  async start(): Promise<void> {
    if (this.running) return;

    if (!this.discordConfig.token) {
      logger.warn('Discord token not configured, channel disabled');
      return;
    }

    try {
      // @ts-ignore - discord.js is an optional dependency
      const { Client, GatewayIntentBits } = await import('discord.js');
      
      this.client = new Client({
        intents: this.discordConfig.intents || [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.MessageContent,
          GatewayIntentBits.DirectMessages,
        ],
      });

      const client = this.client as { 
        on: (event: string, handler: (...args: unknown[]) => void) => void;
        login: (token: string) => Promise<void>;
        user: { username: string };
      };

      client.on('ready', () => {
        logger.info({ username: client.user.username }, 'Discord bot ready');
      });

      client.on('messageCreate', (message: unknown) => {
        const msg = message as { 
          author: { bot: boolean; id: string; username: string };
          channelId: string;
          content: string;
        };
        if (msg.author.bot) return;

        this.publishInbound({
          chat_id: msg.channelId,
          sender_id: msg.author.id,
          sender_name: msg.author.username,
          text: msg.content,
        });
      });

      await client.login(this.discordConfig.token);
      
      this.subscribeToOutbound();
      this.running = true;
      logger.info('Discord channel started');
    } catch (err) {
      logger.error({ err }, 'Failed to start Discord channel');
    }
  }

  async stop(): Promise<void> {
    if (!this.running) return;

    try {
      const client = this.client as { destroy: () => void };
      client?.destroy();
    } catch (err) {
      logger.error({ err }, 'Error stopping Discord channel');
    }

    this.unsubscribeAll();
    this.client = null;
    this.running = false;
    logger.info('Discord channel stopped');
  }

  async send(chatId: string, text: string, _options?: SendOptions): Promise<void> {
    try {
      const client = this.client as { 
        channels: { 
          fetch: (id: string) => Promise<{ send: (content: string) => Promise<unknown> }>;
        };
      };
      const channel = await client.channels.fetch(chatId);
      await channel.send(text);
    } catch (err) {
      logger.error({ err, chat_id: chatId }, 'Failed to send Discord message');
    }
  }

  async sendDelta(_chatId: string, _delta: string, _options?: SendOptions): Promise<void> {
  }
}
