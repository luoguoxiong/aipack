import { logger } from '../utils/logger.js';
import { MessageBus } from '../bus/queue.js';
import { BaseChannel, ChannelConfig, SendOptions } from './base.js';

export interface DingTalkChannelConfig extends ChannelConfig {
  client_id?: string;
  client_secret?: string;
  allow_from?: string[];
  allow_remote_media_redirects?: boolean;
  remote_media_redirect_allowed_hosts?: string[];
  group_user_isolation?: boolean;
  webhook_url?: string;
  webhook_secret?: string;
}

export class DingTalkChannel extends BaseChannel {
  name = 'dingtalk';
  private client: unknown = null;
  private processedMessageIds: Set<string> = new Set();
  private backgroundTasks: Set<Promise<unknown>> = new Set();
  private keepAliveTimer?: NodeJS.Timeout;

  protected get dingtalkConfig(): DingTalkChannelConfig {
    return this.config as DingTalkChannelConfig;
  }

  constructor(bus: MessageBus, config: DingTalkChannelConfig) {
    super(bus, config);
    this.name = config.name || 'dingtalk';
  }

  async start(): Promise<void> {
    if (this.running) return;

    const { client_id, client_secret } = this.dingtalkConfig;
    if (!client_id || !client_secret) {
      logger.warn('DingTalk client_id and client_secret not configured, channel disabled');
      return;
    }

    this.subscribeToOutbound();
    this.subscribeToStream();

    try {
      await this.startStreamClient();
    } catch (err) {
      logger.error({ err }, 'Failed to start DingTalk stream client');
    }

    this.running = true;
    logger.info('DingTalk channel started');
  }

  private async startStreamClient(): Promise<void> {
    try {
      // @ts-ignore - dynamic import
      const dingtalkStream = await import('dingtalk-stream');
      const { Credential, DingTalkStreamClient } = dingtalkStream;

      const credential = new Credential(this.dingtalkConfig.client_id, this.dingtalkConfig.client_secret);
      const client = new DingTalkStreamClient({ credential });

      const handler = this.createCallbackHandler();
      client.registerCallbackHandler('/v1.0/im/bot/messages/get', handler);

      this.client = client;

      if (typeof client['start'] === 'function') {
        client['start']();
      }

      logger.info('DingTalk stream client started');
    } catch (err) {
      logger.debug({ err }, 'DingTalk stream SDK not available, install dingtalk-stream for full functionality');
    }
  }

  private createCallbackHandler(): unknown {
    const self = this;
    return async function (message: Record<string, unknown>) {
      try {
        await self.processStreamMessage(message);
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: 'OK' }),
        };
      } catch (err) {
        logger.error({ err }, 'Error processing DingTalk message');
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: 'Error' }),
        };
      }
    };
  }

  private async processStreamMessage(message: Record<string, unknown>): Promise<void> {
    try {
      const data = message.data || message;
      const msgtype = (data as Record<string, unknown>)['msgtype'] as string;
      const text = (data as Record<string, unknown>)['text'] as Record<string, unknown>;
      const content = text?.content as string || '';

      const senderStaffId = (data as Record<string, unknown>)['senderStaffId'] as string
        || (data as Record<string, unknown>)['senderId'] as string
        || 'unknown';
      const senderNick = (data as Record<string, unknown>)['senderNick'] as string || 'Unknown';

      const conversationType = (data as Record<string, unknown>)['conversationType'] as string || '1';
      const conversationId = (data as Record<string, unknown>)['conversationId'] as string
        || (data as Record<string, unknown>)['openConversationId'] as string
        || '';

      const msgId = (data as Record<string, unknown>)['msgId'] as string || '';
      if (!msgId || this.processedMessageIds.has(msgId)) return;
      this.processedMessageIds.add(msgId);
      if (this.processedMessageIds.size > 1000) {
        const first = this.processedMessageIds.values().next().value;
        if (first) this.processedMessageIds.delete(first);
      }

      if (!content.trim()) {
        logger.warn(`Received empty or unsupported message type: ${msgtype}`);
        return;
      }

      logger.info(`Received DingTalk message from ${senderNick} (${senderStaffId}): ${content}`);

      const task = this.onMessage(
        content,
        senderStaffId,
        senderNick,
        conversationType,
        conversationId,
      );
      this.backgroundTasks.add(task);
      task.finally(() => this.backgroundTasks.delete(task));
    } catch (err) {
      logger.error({ err }, 'Error processing DingTalk stream message');
    }
  }

  private async onMessage(
    content: string,
    senderId: string,
    senderName: string,
    conversationType: string,
    conversationId: string,
  ): Promise<void> {
    try {
      const chatId = conversationType === '2' || conversationType === 'group'
        ? `group:${conversationId}`
        : senderId;

      let text = content;
      const botRegex = /@[^ ]+\s*/g;
      if (conversationType === '2' || conversationType === 'group') {
        text = text.replace(botRegex, '').trim();
      }

      if (!text) return;

      this.publishInbound({
        chat_id: chatId,
        sender_id: senderId,
        sender_name: senderName,
        text,
        metadata: {
          conversation_type: conversationType,
          conversation_id: conversationId,
        },
      });
    } catch (err) {
      logger.error({ err }, 'Error handling DingTalk message');
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
        client['stop']();
      } catch (err) {
        logger.debug({ err }, 'Error stopping DingTalk client');
      }
    }

    this.unsubscribeAll();
    this.running = false;
    logger.info('DingTalk channel stopped');
  }

  async send(chatId: string, text: string, options?: SendOptions): Promise<void> {
    try {
      if (this.dingtalkConfig.webhook_url) {
        await this.sendViaWebhook(text);
      } else {
        await this.sendViaApi(chatId, text);
      }
    } catch (err) {
      logger.error({ err, chat_id: chatId }, 'Failed to send DingTalk message');
      throw err;
    }
  }

  private async sendViaWebhook(text: string): Promise<void> {
    const webhookUrl = this.dingtalkConfig.webhook_url;
    if (!webhookUrl) throw new Error('Webhook URL not configured');

    const { default: axios } = await import('axios');

    const timestamp = Date.now();
    let sign = '';
    if (this.dingtalkConfig.webhook_secret) {
      const crypto = require('crypto');
      const stringToSign = `${timestamp}\n${this.dingtalkConfig.webhook_secret}`;
      const hmac = crypto.createHmac('sha256', this.dingtalkConfig.webhook_secret);
      hmac.update(stringToSign);
      sign = encodeURIComponent(hmac.digest('base64'));
    }

    const url = sign ? `${webhookUrl}&timestamp=${timestamp}&sign=${sign}` : webhookUrl;

    await axios.post(
      url,
      {
        msgtype: 'text',
        text: { content: text },
      },
      { timeout: 30000 }
    );
  }

  private async sendViaApi(chatId: string, text: string): Promise<void> {
    const { default: axios } = await import('axios');
    const accessToken = await this.getAccessToken();
    if (!accessToken) throw new Error('Failed to get DingTalk access token');

    let conversationId = chatId;
    let isGroup = false;
    if (chatId.startsWith('group:')) {
      conversationId = chatId.slice('group:'.length);
      isGroup = true;
    }

    const url = 'https://api.dingtalk.com/v1.0/robot/batchSend';
    const response = await axios.post(
      url,
      {
        msgParam: JSON.stringify({ text }),
        msgKey: 'sampleText',
        groupId: isGroup ? conversationId : undefined,
        userIds: isGroup ? undefined : [conversationId],
      },
      {
        headers: {
          'x-acs-dingtalk-access-token': accessToken,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      }
    );

    if (response.data.code && response.data.code !== 0) {
      throw new Error(`DingTalk API error: ${response.data.message}`);
    }
  }

  private async getAccessToken(): Promise<string | null> {
    try {
      const { default: axios } = await import('axios');
      const response = await axios.post(
        'https://api.dingtalk.com/v1.0/oauth2/accessToken',
        {
          appKey: this.dingtalkConfig.client_id,
          appSecret: this.dingtalkConfig.client_secret,
        },
        { timeout: 30000 }
      );
      return response.data.accessToken || null;
    } catch (err) {
      logger.error({ err }, 'Failed to get DingTalk access token');
      return null;
    }
  }

  async sendDelta(chatId: string, delta: string, options?: SendOptions): Promise<void> {
    if (!this.config.streaming) return;
  }

  handleWebhookEvent(body: Record<string, unknown>): void {
    this.processStreamMessage(body).catch(err => {
      logger.error({ err }, 'Error handling DingTalk webhook event');
    });
  }
}
