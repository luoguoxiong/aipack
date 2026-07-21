import { logger } from '../utils/logger.js';
import { MessageBus } from '../bus/queue.js';
import { BaseChannel, ChannelConfig, SendOptions } from './base.js';

export interface WhatsAppChannelConfig extends ChannelConfig {
  session_name?: string;
  data_path?: string;
  qr_timeout?: number;
  auth_strategy?: 'local' | 'remote';
}

export class WhatsAppChannel extends BaseChannel {
  name = 'whatsapp';
  private client: unknown = null;
  private processedMessageIds: Set<string> = new Set();
  private ready = false;
  private streamBuffers: Map<string, string> = new Map();

  protected get whatsappConfig(): WhatsAppChannelConfig {
    return this.config as WhatsAppChannelConfig;
  }

  constructor(bus: MessageBus, config: WhatsAppChannelConfig) {
    super(bus, config);
    this.name = config.name || 'whatsapp';
  }

  async start(): Promise<void> {
    if (this.running) return;

    this.subscribeToOutbound();
    this.subscribeToStream();

    try {
      await this.initializeClient();
    } catch (err) {
      logger.error({ err }, 'Failed to initialize WhatsApp client');
    }

    this.running = true;
    logger.info('WhatsApp channel started');
  }

  private async initializeClient(): Promise<void> {
    try {
      // @ts-ignore - dynamic import
      const { Client, LocalAuth } = await import('whatsapp-web.js');

      const sessionName = this.whatsappConfig.session_name || 'nanobot';
      const dataPath = this.whatsappConfig.data_path || './.wwebjs_auth';

      this.client = new Client({
        authStrategy: new LocalAuth({
          clientId: sessionName,
          dataPath,
        }),
        puppeteer: {
          args: ['--no-sandbox', '--disable-setuid-sandbox'],
        },
      });

      const client = this.client as Record<string, unknown>;

      if (typeof client['on'] === 'function') {
        client['on']('qr', (qr: string) => {
          logger.warn(`WhatsApp QR code received. Scan it with your phone. QR: ${qr.slice(0, 20)}...`);
          this.printQrCode(qr);
        });

        client['on']('ready', () => {
          this.ready = true;
          logger.info('WhatsApp client is ready');
        });

        client['on']('authenticated', () => {
          logger.info('WhatsApp authenticated');
        });

        client['on']('auth_failure', (msg: string) => {
          logger.error({ msg }, 'WhatsApp authentication failure');
        });

        client['on']('disconnected', (reason: string) => {
          this.ready = false;
          logger.warn({ reason }, 'WhatsApp disconnected');
        });

        client['on']('message', async (msg: unknown) => {
          await this.handleMessage(msg);
        });
      }

      if (typeof client['initialize'] === 'function') {
        await client['initialize']();
      }
    } catch (err) {
      logger.debug({ err }, 'whatsapp-web.js not available, install it for WhatsApp channel');
    }
  }

  private printQrCode(qr: string): void {
    logger.info('WhatsApp QR Code: Open https://api.qrserver.com/v1/create-qr-code/?data=' + encodeURIComponent(qr) + '&size=300x300');
  }

  private async handleMessage(msg: unknown): Promise<void> {
    try {
      const message = msg as Record<string, unknown>;
      const msgId = (message.id as Record<string, unknown> | undefined)?.id as string || '';
      if (!msgId || this.processedMessageIds.has(msgId)) return;

      this.processedMessageIds.add(msgId);
      if (this.processedMessageIds.size > 1000) {
        const first = this.processedMessageIds.values().next().value;
        if (first) this.processedMessageIds.delete(first);
      }

      const from = message.from as string || '';
      const author = message.author as string;
      const chatId = author || from;
      const senderName = (message._data as Record<string, unknown> | undefined)?.notifyName as string || chatId;
      const body = message.body as string || '';

      if (!body.trim()) return;

      const isGroup = from.includes('@g.us');

      this.publishInbound({
        chat_id: from,
        sender_id: chatId,
        sender_name: senderName,
        text: body,
        metadata: {
          message_id: msgId,
          is_group: isGroup,
          author,
        },
      });
    } catch (err) {
      logger.error({ err }, 'Error handling WhatsApp message');
    }
  }

  async stop(): Promise<void> {
    if (!this.running) return;

    const client = this.client as Record<string, unknown> | null;
    if (client && typeof client['destroy'] === 'function') {
      try {
        await client['destroy']();
      } catch (err) {
        logger.debug({ err }, 'Error destroying WhatsApp client');
      }
    }

    this.ready = false;
    this.unsubscribeAll();
    this.running = false;
    logger.info('WhatsApp channel stopped');
  }

  async send(chatId: string, text: string, options?: SendOptions): Promise<void> {
    if (!this.ready || !this.client) {
      throw new Error('WhatsApp client not ready');
    }

    try {
      const client = this.client as Record<string, unknown>;
      if (typeof client['sendMessage'] === 'function') {
        await client['sendMessage'](chatId, text);

        if (options?.media && options.media.length > 0) {
          // @ts-ignore - dynamic import
          const { MessageMedia } = await import('whatsapp-web.js');
          const fs = await import('fs');
          const path = await import('path');

          for (const filePath of options.media) {
            const data = fs.readFileSync(filePath, { encoding: 'base64' });
            const fileName = path.basename(filePath);
            const mimetype = this.guessMimeType(filePath);
            const media = new MessageMedia(mimetype, data, fileName);
            await client['sendMessage'](chatId, media);
          }
        }
      }
    } catch (err) {
      logger.error({ err, chat_id: chatId }, 'Failed to send WhatsApp message');
      throw err;
    }
  }

  private guessMimeType(filename: string): string {
    const ext = filename.toLowerCase().slice(filename.lastIndexOf('.'));
    const mimeMap: Record<string, string> = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.mp4': 'video/mp4',
      '.pdf': 'application/pdf',
      '.txt': 'text/plain',
    };
    return mimeMap[ext] || 'application/octet-stream';
  }

  async sendDelta(chatId: string, delta: string, options?: SendOptions): Promise<void> {
    if (!this.config.streaming) return;

    const streamEnd = options?.metadata?.stream_end as boolean;
    const streamId = (options?.metadata?.stream_id as string) || chatId;

    const current = this.streamBuffers.get(streamId) || '';
    const next = current + delta;
    this.streamBuffers.set(streamId, next);

    if (streamEnd) {
      await this.send(chatId, next, options);
      this.streamBuffers.delete(streamId);
    }
  }
}
