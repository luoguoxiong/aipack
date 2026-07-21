import { logger } from '../utils/logger.js';
import { MessageBus } from '../bus/queue.js';
import { BaseChannel, ChannelConfig, SendOptions } from './base.js';

export interface QQChannelConfig extends ChannelConfig {
  app_id?: string;
  secret?: string;
  allow_from?: string[];
  msg_format?: 'plain' | 'markdown';
  ack_message?: string;
  media_dir?: string;
  download_chunk_size?: number;
  download_max_bytes?: number;
}

const QQ_FILE_TYPE_IMAGE = 1;
const QQ_FILE_TYPE_FILE = 4;

const IMAGE_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.tif', '.tiff', '.ico', '.svg',
]);

function isImageName(name: string): boolean {
  const ext = name.toLowerCase().slice(name.lastIndexOf('.'));
  return IMAGE_EXTS.has(ext);
}

function guessSendFileType(filename: string): number {
  if (isImageName(filename)) return QQ_FILE_TYPE_IMAGE;
  return QQ_FILE_TYPE_FILE;
}

function sanitizeFilename(name: string): string {
  name = name.trim();
  name = name.split(/[\\/]/).pop() || name;
  name = name.replace(/[^\w.\-()\[\]（）【】\u4e00-\u9fff]+/g, '_').replace(/^[._\s]+|[._\s]+$/g, '');
  return name || 'file';
}

export class QQChannel extends BaseChannel {
  name = 'qq';
  private client: unknown = null;
  private processedIds: Set<string> = new Set();
  private msgSeq = 1;
  private chatTypeCache: Map<string, string> = new Map();
  private keepAliveTimer?: NodeJS.Timeout;

  protected get qqConfig(): QQChannelConfig {
    return this.config as QQChannelConfig;
  }

  constructor(bus: MessageBus, config: QQChannelConfig) {
    super(bus, config);
    this.name = config.name || 'qq';
  }

  async start(): Promise<void> {
    if (this.running) return;

    const { app_id, secret } = this.qqConfig;
    if (!app_id || !secret) {
      logger.warn('QQ app_id and secret not configured, channel disabled');
      return;
    }

    this.subscribeToOutbound();
    this.subscribeToStream();

    try {
      await this.connectBot();
    } catch (err) {
      logger.error({ err }, 'Failed to start QQ bot');
    }

    this.running = true;
    logger.info('QQ channel started');
  }

  private async connectBot(): Promise<void> {
    try {
      // @ts-ignore - dynamic import
      const botpy = await import('botpy');

      const intents = new botpy.Intents({
        public_messages: true,
        direct_message: true,
      });

      class _Bot extends botpy.Client {
        private channel: QQChannel;

        constructor(channel: QQChannel) {
          super({ intents, ext_handlers: false });
          this.channel = channel;
        }

        async on_ready(): Promise<void> {
          logger.info(`QQ bot ready: ${this.robot?.name || 'unknown'}`);
        }

        async on_c2c_message_create(message: unknown): Promise<void> {
          await this.channel.onMessage(message, false);
        }

        async on_group_at_message_create(message: unknown): Promise<void> {
          await this.channel.onMessage(message, true);
        }
      }

      this.client = new _Bot(this);
      const client = this.client as Record<string, unknown>;

      if (typeof client['start'] === 'function') {
        await client['start']({ appID: this.qqConfig.app_id, token: this.qqConfig.secret });
      }
    } catch (err) {
      logger.debug({ err }, 'QQ SDK not available, install botpy for full functionality');
    }
  }

  async onMessage(message: unknown, isGroup: boolean): Promise<void> {
    try {
      const msg = message as Record<string, unknown>;
      const msgId = msg.id as string || '';
      if (!msgId) return;

      if (this.processedIds.has(msgId)) return;
      this.processedIds.add(msgId);
      if (this.processedIds.size > 1000) {
        const first = this.processedIds.values().next().value;
        if (first) this.processedIds.delete(first);
      }

      const author = msg.author as Record<string, unknown>;
      const senderId = author?.id as string || 'unknown';
      const senderName = author?.username as string || 'Unknown';

      let chatId = '';
      if (isGroup) {
        chatId = msg.group_id as string || msg.group_openid as string || '';
      } else {
        chatId = (msg.author as Record<string, unknown> | undefined)?.id as string || msg.user_openid as string || '';
      }

      if (!chatId) return;

      const content = msg.content as string || '';
      const cleanedContent = content.replace(/<@!\d+>/g, '').trim();

      if (!cleanedContent) return;

      this.chatTypeCache.set(chatId, isGroup ? 'group' : 'c2c');

      this.publishInbound({
        chat_id: chatId,
        sender_id: senderId,
        sender_name: senderName,
        text: cleanedContent,
        metadata: {
          message_id: msgId,
          chat_type: isGroup ? 'group' : 'c2c',
        },
      });
    } catch (err) {
      logger.error({ err }, 'Error processing QQ message');
    }
  }

  async stop(): Promise<void> {
    if (!this.running) return;

    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = undefined;
    }

    const client = this.client as Record<string, unknown> | null;
    if (client && typeof client['stop'] === 'function') {
      try {
        await client['stop']();
      } catch (err) {
        logger.debug({ err }, 'Error stopping QQ client');
      }
    }

    this.unsubscribeAll();
    this.running = false;
    logger.info('QQ channel stopped');
  }

  async send(chatId: string, text: string, options?: SendOptions): Promise<void> {
    try {
      const chatType = this.chatTypeCache.get(chatId) || 'c2c';
      const client = this.client as Record<string, unknown> | null;

      if (client && typeof client['api'] === 'object') {
        await this.sendViaSdk(chatId, text, chatType, options);
      } else {
        await this.sendViaApi(chatId, text, chatType);
      }
    } catch (err) {
      logger.error({ err, chat_id: chatId }, 'Failed to send QQ message');
      throw err;
    }
  }

  private async sendViaSdk(chatId: string, text: string, chatType: string, options?: SendOptions): Promise<void> {
    const client = this.client as Record<string, unknown>;
    const api = client.api as Record<string, unknown>;

    try {
      const msgFormat = this.qqConfig.msg_format || 'plain';
      const content = msgFormat === 'markdown' ? text : text;

      this.msgSeq++;

      if (chatType === 'group') {
        if (typeof api['postGroupMessage'] === 'function') {
          await api['postGroupMessage'](chatId, {
            msg_type: 0,
            msg_id: options?.reply_to,
            msg_seq: this.msgSeq,
            content: JSON.stringify({ text: content }),
          });
        }
      } else {
        if (typeof api['postC2CMessage'] === 'function') {
          await api['postC2CMessage'](chatId, {
            msg_type: 0,
            msg_id: options?.reply_to,
            msg_seq: this.msgSeq,
            content: JSON.stringify({ text: content }),
          });
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error sending via QQ SDK');
      throw err;
    }
  }

  private async sendViaApi(chatId: string, text: string, chatType: string): Promise<void> {
    try {
      const { default: axios } = await import('axios');
      const accessToken = await this.getAccessToken();
      if (!accessToken) throw new Error('Failed to get QQ access token');

      const url = chatType === 'group'
        ? 'https://api.sgroup.qq.com/group/@me/messages'
        : `https://api.sgroup.qq.com/dms/${chatId}/messages`;

      await axios.post(
        url,
        { content: text, msg_id: '' },
        {
          headers: { Authorization: `QQBot ${accessToken}` },
          timeout: 30000,
        }
      );
    } catch (err) {
      logger.error({ err }, 'Error sending via QQ API');
      throw err;
    }
  }

  private async getAccessToken(): Promise<string | null> {
    try {
      const { default: axios } = await import('axios');
      const response = await axios.post(
        'https://bots.qq.com/app/getAppAccessToken',
        {
          appId: this.qqConfig.app_id,
          clientSecret: this.qqConfig.secret,
        },
        { timeout: 30000 }
      );
      return response.data.access_token || null;
    } catch (err) {
      logger.error({ err }, 'Failed to get QQ access token');
      return null;
    }
  }

  async sendDelta(chatId: string, delta: string, options?: SendOptions): Promise<void> {
    if (!this.config.streaming) return;
  }
}
