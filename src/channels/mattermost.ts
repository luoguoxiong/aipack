import { logger } from '../utils/logger.js';
import { MessageBus } from '../bus/queue.js';
import { BaseChannel, ChannelConfig, SendOptions } from './base.js';

export interface MattermostChannelConfig extends ChannelConfig {
  server_url?: string;
  team?: string;
  username?: string;
  password?: string;
  token?: string;
  webhook_url?: string;
  webhook_username?: string;
  webhook_icon_url?: string;
  allow_from?: string[];
}

type MattermostClient = {
  setUrl: (url: string) => void;
  setToken: (token: string) => void;
  login: (username: string, password: string) => Promise<unknown>;
  createPost: (post: Record<string, unknown>) => Promise<unknown>;
  getUser: (userId: string) => Promise<Record<string, unknown>>;
  token: string;
};

type MattermostWebSocket = {
  addMessageListener: (handler: (msg: Record<string, unknown>) => void) => void;
  close: () => void;
};

export class MattermostChannel extends BaseChannel {
  name = 'mattermost';
  private client: MattermostClient | null = null;
  private processedPostIds: Set<string> = new Set();
  private connected = false;
  private webSocketClient: MattermostWebSocket | null = null;
  private streamBuffers: Map<string, string> = new Map();

  protected get mattermostConfig(): MattermostChannelConfig {
    return this.config as MattermostChannelConfig;
  }

  constructor(bus: MessageBus, config: MattermostChannelConfig) {
    super(bus, config);
    this.name = config.name || 'mattermost';
  }

  async start(): Promise<void> {
    if (this.running) return;

    this.subscribeToOutbound();
    this.subscribeToStream();

    try {
      await this.initializeClient();
    } catch (err) {
      logger.error({ err }, 'Failed to initialize Mattermost client');
    }

    this.running = true;
    logger.info('Mattermost channel started');
  }

  private async initializeClient(): Promise<void> {
    try {
      // @ts-ignore - dynamic import
      const mattermost = await import('@mattermost/client');
      const { Client4, WebSocketClient } = mattermost;

      const serverUrl = this.mattermostConfig.server_url;
      const token = this.mattermostConfig.token;
      const username = this.mattermostConfig.username;
      const password = this.mattermostConfig.password;

      if (!serverUrl) {
        logger.debug('Mattermost server_url not configured');
        return;
      }

      const client = new Client4() as MattermostClient;
      client.setUrl(serverUrl);

      if (token) {
        client.setToken(token);
        this.client = client;
      } else if (username && password) {
        await client.login(username, password);
        this.client = client;
      } else {
        logger.debug('Mattermost token or username/password not configured, using webhook mode only');
        return;
      }

      this.connected = true;

      try {
        if (WebSocketClient) {
          const wsUrl = serverUrl.replace(/^http/, 'ws');
          const wsClient = new WebSocketClient(
            wsUrl,
            '',
            client.token || '',
            '',
            true,
          ) as MattermostWebSocket;

          this.webSocketClient = wsClient;

          wsClient.addMessageListener((msg: Record<string, unknown>) => {
            this.handleWebSocketMessage(msg).catch(err => {
              logger.error({ err }, 'Error handling Mattermost WebSocket message');
            });
          });

          logger.info('Mattermost WebSocket connected');
        }
      } catch (err) {
        logger.debug({ err }, 'Mattermost WebSocket not available');
      }

      logger.info('Mattermost client initialized');
    } catch (err) {
      logger.debug({ err }, '@mattermost/client not available, using webhook mode');
    }
  }

  private async handleWebSocketMessage(msg: Record<string, unknown>): Promise<void> {
    try {
      if (msg.event === 'posted') {
        const data = msg.data as Record<string, unknown>;
        const postStr = data.post as string;
        if (!postStr) return;

        const post = JSON.parse(postStr);
        const postId = post.id as string;
        const channelId = post.channel_id as string;
        const userId = post.user_id as string;
        const message = post.message as string || '';

        if (!postId || !message.trim()) return;
        if (this.processedPostIds.has(postId)) return;
        this.processedPostIds.add(postId);
        if (this.processedPostIds.size > 1000) {
          const first = this.processedPostIds.values().next().value;
          if (first) this.processedPostIds.delete(first);
        }

        let senderName = userId;
        try {
          if (this.client) {
            const user = await this.client.getUser(userId);
            senderName = user?.username as string || user?.nickname as string || userId;
          }
        } catch {
          // ignore
        }

        this.publishInbound({
          chat_id: channelId,
          sender_id: userId,
          sender_name: senderName,
          text: message,
          metadata: {
            post_id: postId,
            channel_id: channelId,
          },
        });
      }
    } catch (err) {
      logger.error({ err }, 'Error handling Mattermost WebSocket message');
    }
  }

  async stop(): Promise<void> {
    if (!this.running) return;

    if (this.webSocketClient) {
      try {
        this.webSocketClient.close();
      } catch (err) {
        logger.debug({ err }, 'Error closing Mattermost WebSocket');
      }
    }

    this.webSocketClient = null;
    this.connected = false;
    this.unsubscribeAll();
    this.running = false;
    logger.info('Mattermost channel stopped');
  }

  async send(chatId: string, text: string, options?: SendOptions): Promise<void> {
    try {
      if (this.client && this.connected) {
        await this.sendViaApi(chatId, text);
      } else if (this.mattermostConfig.webhook_url) {
        await this.sendViaWebhook(text);
      } else {
        throw new Error('Mattermost not configured: no API client or webhook URL');
      }
    } catch (err) {
      logger.error({ err, chat_id: chatId }, 'Failed to send Mattermost message');
      throw err;
    }
  }

  private async sendViaApi(channelId: string, text: string): Promise<void> {
    if (!this.client) throw new Error('Mattermost client not initialized');

    try {
      await this.client.createPost({
        channel_id: channelId,
        message: text,
      });
    } catch (err) {
      logger.error({ err }, 'Error sending via Mattermost API');
      throw err;
    }
  }

  private async sendViaWebhook(text: string): Promise<void> {
    try {
      const { default: axios } = await import('axios');
      const webhookUrl = this.mattermostConfig.webhook_url;
      if (!webhookUrl) throw new Error('Webhook URL not configured');

      const payload: Record<string, unknown> = {
        text,
      };

      if (this.mattermostConfig.webhook_username) {
        payload.username = this.mattermostConfig.webhook_username;
      }
      if (this.mattermostConfig.webhook_icon_url) {
        payload.icon_url = this.mattermostConfig.webhook_icon_url;
      }

      await axios.post(webhookUrl, payload, { timeout: 30000 });
    } catch (err) {
      logger.error({ err }, 'Error sending via Mattermost webhook');
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
