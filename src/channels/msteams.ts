import { logger } from '../utils/logger.js';
import { MessageBus } from '../bus/queue.js';
import { BaseChannel, ChannelConfig, SendOptions } from './base.js';

export interface MSTeamsChannelConfig extends ChannelConfig {
  app_id?: string;
  app_password?: string;
  webhook_url?: string;
  tenant_id?: string;
  service_url?: string;
  port?: number;
  path?: string;
  allow_from?: string[];
}

export class MSTeamsChannel extends BaseChannel {
  name = 'msteams';
  private adapter: unknown = null;
  private processedActivityIds: Set<string> = new Set();
  private server: unknown = null;
  private streamBuffers: Map<string, string> = new Map();

  protected get msteamsConfig(): MSTeamsChannelConfig {
    return this.config as MSTeamsChannelConfig;
  }

  constructor(bus: MessageBus, config: MSTeamsChannelConfig) {
    super(bus, config);
    this.name = config.name || 'msteams';
  }

  async start(): Promise<void> {
    if (this.running) return;

    this.subscribeToOutbound();
    this.subscribeToStream();

    try {
      if (this.msteamsConfig.app_id && this.msteamsConfig.app_password) {
        await this.initializeBotFramework();
      }
    } catch (err) {
      logger.error({ err }, 'Failed to initialize MS Teams Bot Framework');
    }

    this.running = true;
    logger.info('MS Teams channel started');
  }

  private async initializeBotFramework(): Promise<void> {
    try {
      // @ts-ignore - dynamic import
      const botbuilder = await import('botbuilder');
      const { BotFrameworkAdapter, TurnContext } = botbuilder;

      const adapter = new BotFrameworkAdapter({
        appId: this.msteamsConfig.app_id,
        appPassword: this.msteamsConfig.app_password,
      });

      this.adapter = adapter;

      adapter.onTurnError = async (context: any, error: unknown) => {
        logger.error({ error }, 'MS Teams bot error');
      };

      const myBot = {
        onTurn: async (context: any) => {
          await this.handleTurn(context);
        },
      };

      if (this.msteamsConfig.port) {
        const { createServer, IncomingMessage, ServerResponse } = await import('http');
        const port = this.msteamsConfig.port || 3978;
        const path = this.msteamsConfig.path || '/api/messages';

        const server = createServer(async (req: typeof IncomingMessage.prototype, res: typeof ServerResponse.prototype) => {
          const url = req.url || '';
          if (url.startsWith(path)) {
            const buffers: Buffer[] = [];
            for await (const chunk of req as unknown as AsyncIterable<Buffer>) {
              buffers.push(chunk);
            }
            const body = Buffer.concat(buffers).toString();

            adapter.processActivity(req, res, async (context: any) => {
              await this.handleTurn(context);
            });
          } else {
            res.statusCode = 404;
            res.end('Not Found');
          }
        });

        server.listen(port, () => {
          logger.info(`MS Teams bot server listening on port ${port}`);
        });

        this.server = server;
      }

      logger.info('MS Teams Bot Framework initialized');
    } catch (err) {
      logger.debug({ err }, 'botbuilder not available, install botbuilder for MS Teams Bot Framework');
    }
  }

  private async handleTurn(context: any): Promise<void> {
    try {
      const activity = context.activity as Record<string, unknown>;
      if (!activity) return;

      const activityType = activity.type as string;
      if (activityType !== 'message') return;

      const activityId = activity.id as string;
      if (!activityId || this.processedActivityIds.has(activityId)) return;
      this.processedActivityIds.add(activityId);
      if (this.processedActivityIds.size > 1000) {
        const first = this.processedActivityIds.values().next().value;
        if (first) this.processedActivityIds.delete(first);
      }

      const text = activity.text as string || '';
      if (!text.trim()) return;

      const from = activity.from as Record<string, unknown>;
      const senderId = from?.id as string || 'unknown';
      const senderName = from?.name as string || senderId;

      const conversation = activity.conversation as Record<string, unknown>;
      const conversationId = conversation?.id as string || senderId;
      const serviceUrl = activity.serviceUrl as string;

      this.publishInbound({
        chat_id: conversationId,
        sender_id: senderId,
        sender_name: senderName,
        text,
        metadata: {
          activity_id: activityId,
          conversation_id: conversationId,
          service_url: serviceUrl,
        },
      });
    } catch (err) {
      logger.error({ err }, 'Error handling MS Teams turn');
    }
  }

  async stop(): Promise<void> {
    if (!this.running) return;

    const server = this.server as Record<string, unknown> | null;
    if (server && typeof server['close'] === 'function') {
      try {
        server['close']();
      } catch (err) {
        logger.debug({ err }, 'Error closing MS Teams server');
      }
    }

    this.server = null;
    this.adapter = null;
    this.unsubscribeAll();
    this.running = false;
    logger.info('MS Teams channel stopped');
  }

  async send(chatId: string, text: string, options?: SendOptions): Promise<void> {
    try {
      if (this.msteamsConfig.webhook_url) {
        await this.sendViaWebhook(text);
      } else if (this.adapter && options?.metadata?.service_url) {
        await this.sendViaBotFramework(chatId, text, options);
      } else if (this.msteamsConfig.webhook_url) {
        await this.sendViaWebhook(text);
      } else {
        throw new Error('MS Teams not configured: no webhook URL or Bot Framework');
      }
    } catch (err) {
      logger.error({ err, chat_id: chatId }, 'Failed to send MS Teams message');
      throw err;
    }
  }

  private async sendViaWebhook(text: string): Promise<void> {
    try {
      const { default: axios } = await import('axios');
      const webhookUrl = this.msteamsConfig.webhook_url;
      if (!webhookUrl) throw new Error('Webhook URL not configured');

      const card = {
        type: 'message',
        attachments: [
          {
            contentType: 'application/vnd.microsoft.card.adaptive',
            content: {
              type: 'AdaptiveCard',
              $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
              version: '1.4',
              body: [
                {
                  type: 'TextBlock',
                  text: text,
                  wrap: true,
                },
              ],
            },
          },
        ],
      };

      await axios.post(webhookUrl, card, { timeout: 30000 });
    } catch (err) {
      logger.error({ err }, 'Error sending via MS Teams webhook');
      throw err;
    }
  }

  private async sendViaBotFramework(chatId: string, text: string, options?: SendOptions): Promise<void> {
    try {
      // @ts-ignore - dynamic import
      const botbuilder = await import('botbuilder');
      const { MessageFactory } = botbuilder;

      const adapter = this.adapter as any;
      const serviceUrl = options?.metadata?.service_url as string || this.msteamsConfig.service_url;
      const appId = this.msteamsConfig.app_id;

      if (!adapter || !serviceUrl) {
        throw new Error('Bot Framework adapter or service URL not available');
      }

      const conversationReference = {
        conversation: { id: chatId },
        serviceUrl,
      };

      if (typeof adapter.continueConversation === 'function') {
        await adapter.continueConversation(appId, conversationReference, async (context: any) => {
          const reply = MessageFactory.text(text);
          await context.sendActivity(reply);
        });
      }
    } catch (err) {
      logger.error({ err }, 'Error sending via MS Teams Bot Framework');
      throw err;
    }
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
