import { logger } from '../utils/logger.js';
import { MessageBus } from '../bus/queue.js';
import { BaseChannel, ChannelConfig, SendOptions } from './base.js';
import { generateId } from '../utils/helpers.js';

export interface FeishuChannelConfig extends ChannelConfig {
  app_id?: string;
  app_secret?: string;
  encrypt_key?: string;
  verification_token?: string;
  allow_from?: string[];
  react_emoji?: string;
  done_emoji?: string;
  group_policy?: 'open' | 'mention';
  reply_to_message?: boolean;
  domain?: 'feishu' | 'lark';
  topic_isolation?: boolean;
  webhook_url?: string;
  webhook_secret?: string;
  mode?: 'websocket' | 'webhook';
}

const MSG_TYPE_MAP: Record<string, string> = {
  image: '[image]',
  audio: '[audio]',
  file: '[file]',
  sticker: '[sticker]',
};

function extractPostContent(contentJson: Record<string, unknown>): { text: string; images: string[] } {
  const texts: string[] = [];
  const images: string[] = [];

  let root = contentJson;
  if (root['post'] && typeof root['post'] === 'object') {
    root = root['post'] as Record<string, unknown>;
  }

  if (!root || typeof root !== 'object') {
    return { text: '', images: [] };
  }

  if (Array.isArray(root['content'])) {
    const title = root['title'] as string;
    if (title) texts.push(title);
    for (const row of root['content'] as unknown[][]) {
      if (!Array.isArray(row)) continue;
      for (const el of row) {
        if (!el || typeof el !== 'object') continue;
        const tag = (el as Record<string, unknown>)['tag'] as string;
        if (tag === 'text' || tag === 'a') {
          texts.push((el as Record<string, unknown>)['text'] as string || '');
        } else if (tag === 'at') {
          texts.push(`@${(el as Record<string, unknown>)['user_name'] || 'user'}`);
        } else if (tag === 'img') {
          const imageKey = (el as Record<string, unknown>)['image_key'] as string;
          if (imageKey) images.push(imageKey);
        }
      }
    }
    return { text: texts.join(' ').trim(), images };
  }

  for (const key of ['zh_cn', 'en_us', 'ja_jp']) {
    const block = root[key];
    if (block && typeof block === 'object') {
      const result = extractPostContent(block as Record<string, unknown>);
      if (result.text || result.images.length) return result;
    }
  }

  return { text: '', images: [] };
}

function extractInteractiveContent(content: Record<string, unknown> | string): string[] {
  const parts: string[] = [];
  let obj: Record<string, unknown>;

  if (typeof content === 'string') {
    try {
      obj = JSON.parse(content);
    } catch {
      return content.trim() ? [content] : [];
    }
  } else {
    obj = content;
  }

  if (!obj || typeof obj !== 'object') return parts;

  const userDsl = obj['user_dsl'];
  if (typeof userDsl === 'string' && userDsl.trim()) {
    try {
      const dsl = JSON.parse(userDsl);
      if (typeof dsl === 'object') {
        const dslParts = extractInteractiveContent(dsl);
        if (dslParts.length) return dslParts;
      }
    } catch {
      // ignore
    }
  }

  const title = obj['title'];
  if (title) {
    if (typeof title === 'object') {
      const titleContent = (title as Record<string, unknown>)['content'] || (title as Record<string, unknown>)['text'];
      if (titleContent) parts.push(`title: ${titleContent}`);
    } else if (typeof title === 'string') {
      parts.push(`title: ${title}`);
    }
  }

  const elements = obj['elements'];
  if (Array.isArray(elements)) {
    for (const element of elements) {
      parts.push(...extractElementContent(element as Record<string, unknown>));
    }
  }

  const body = obj['body'];
  if (body && typeof body === 'object') {
    const bodyElements = (body as Record<string, unknown>)['elements'];
    if (Array.isArray(bodyElements)) {
      for (const element of bodyElements) {
        parts.push(...extractElementContent(element as Record<string, unknown>));
      }
    }
  }

  const card = obj['card'];
  if (card && typeof card === 'object') {
    parts.push(...extractInteractiveContent(card as Record<string, unknown>));
  }

  return parts;
}

function extractElementContent(element: Record<string, unknown>): string[] {
  const parts: string[] = [];
  if (!element || typeof element !== 'object') return parts;

  const tag = element['tag'] as string;

  if (tag === 'markdown' || tag === 'lark_md') {
    const content = element['content'] as string;
    if (content) parts.push(content);
  } else if (tag === 'text' || tag === 'plain_text') {
    const text = element['text'] || element['content'];
    if (typeof text === 'string' && text.trim()) parts.push(text);
  } else if (tag === 'div') {
    const text = element['text'] as Record<string, unknown>;
    if (text && typeof text === 'object') {
      const content = text['content'] || text['text'];
      if (content) parts.push(content as string);
    }
  } else if (tag === 'a') {
    const href = element['href'] as string;
    if (href) parts.push(`link: ${href}`);
  } else if (tag === 'note') {
    const noteElements = element['elements'] as unknown[];
    if (Array.isArray(noteElements)) {
      for (const ne of noteElements) {
        parts.push(...extractElementContent(ne as Record<string, unknown>));
      }
    }
  }

  return parts;
}

function extractShareCardContent(contentJson: Record<string, unknown>, msgType: string): string {
  const parts: string[] = [];

  if (msgType === 'share_chat') {
    parts.push(`[shared chat: ${contentJson['chat_id'] || ''}]`);
  } else if (msgType === 'share_user') {
    parts.push(`[shared user: ${contentJson['user_id'] || ''}]`);
  } else if (msgType === 'interactive') {
    parts.push(...extractInteractiveContent(contentJson));
  } else if (msgType === 'system') {
    parts.push('[system message]');
  } else if (msgType === 'merge_forward') {
    parts.push('[merged forward messages]');
  }

  return parts.length ? parts.join('\n') : `[${msgType}]`;
}

export class FeishuChannel extends BaseChannel {
  name = 'feishu';
  private client: unknown = null;
  private wsClient: unknown = null;
  private processedMessageIds: Map<string, null> = new Map();
  private botOpenId: string | null = null;
  private streamBufs: Map<string, { text: string; cardId: string | null; sequence: number; lastEdit: number }> = new Map();
  private pollTimer?: NodeJS.Timeout;
  private keepAliveTimer?: NodeJS.Timeout;

  protected get feishuConfig(): FeishuChannelConfig {
    return this.config as FeishuChannelConfig;
  }

  constructor(bus: MessageBus, config: FeishuChannelConfig) {
    super(bus, config);
    this.name = config.name || 'feishu';
  }

  async start(): Promise<void> {
    if (this.running) return;

    const { app_id, app_secret } = this.feishuConfig;
    if (!app_id || !app_secret) {
      logger.warn('Feishu app_id and app_secret not configured, channel disabled');
      return;
    }

    this.subscribeToOutbound();
    this.subscribeToStream();

    const mode = this.feishuConfig.mode || 'websocket';
    if (mode === 'webhook') {
      logger.info('Feishu channel started in webhook mode');
    } else {
      await this.startWebSocket();
    }

    this.running = true;
    logger.info('Feishu channel started');
  }

  private async startWebSocket(): Promise<void> {
    try {
      const larkModule = await this.loadLarkSdk();
      if (!larkModule) {
        logger.warn('Feishu SDK not available, install @larksuiteoapi/node-sdk for WebSocket mode');
        return;
      }

      const { lark, domain } = larkModule;
      const appId = this.feishuConfig.app_id!;
      const appSecret = this.feishuConfig.app_secret!;

      this.client = lark.Client.builder()
        .appId(appId)
        .appSecret(appSecret)
        .domain(domain)
        .build();

      logger.info('Feishu WebSocket client initialized');

      this.keepAliveTimer = setInterval(() => {
        if (!this.running) return;
      }, 30000);
    } catch (err) {
      logger.error({ err }, 'Failed to start Feishu WebSocket');
    }
  }

  private async loadLarkSdk(): Promise<{ lark: any; domain: string } | null> {
    try {
      // @ts-ignore - dynamic import
      const lark = await import('@larksuiteoapi/node-sdk');
      const domain = this.feishuConfig.domain === 'lark' ? 'lark' : 'feishu';
      return { lark, domain };
    } catch {
      return null;
    }
  }

  async stop(): Promise<void> {
    if (!this.running) return;

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = undefined;
    }

    this.unsubscribeAll();
    this.running = false;
    logger.info('Feishu channel stopped');
  }

  async send(chatId: string, text: string, options?: SendOptions): Promise<void> {
    try {
      await this.sendMessage(chatId, text, options);
    } catch (err) {
      logger.error({ err, chat_id: chatId }, 'Failed to send Feishu message');
    }
  }

  private async sendMessage(chatId: string, text: string, options?: SendOptions): Promise<void> {
    const { app_id, app_secret } = this.feishuConfig;
    if (!app_id || !app_secret) {
      throw new Error('Feishu not configured');
    }

    const mode = this.feishuConfig.mode || 'websocket';

    if (mode === 'webhook' && this.feishuConfig.webhook_url) {
      await this.sendViaWebhook(text, options);
    } else {
      await this.sendViaApi(chatId, text, options);
    }
  }

  private async sendViaWebhook(text: string, options?: SendOptions): Promise<void> {
    const webhookUrl = this.feishuConfig.webhook_url;
    if (!webhookUrl) throw new Error('Webhook URL not configured');

    const { default: axios } = await import('axios');

    const payload: Record<string, unknown> = {
      msg_type: 'text',
      content: { text },
    };

    if (this.feishuConfig.webhook_secret) {
      const timestamp = Math.floor(Date.now() / 1000);
      payload['timestamp'] = String(timestamp);
      payload['sign'] = this.generateWebhookSign(timestamp, this.feishuConfig.webhook_secret);
    }

    await axios.post(webhookUrl, payload, { timeout: 30000 });
  }

  private generateWebhookSign(timestamp: number, secret: string): string {
    const crypto = require('crypto');
    const stringToSign = `${timestamp}\n${secret}`;
    const hmac = crypto.createHmac('sha256', stringToSign);
    const sign = hmac.digest('base64');
    return sign;
  }

  private async sendViaApi(chatId: string, text: string, options?: SendOptions): Promise<void> {
    try {
      const { default: axios } = await import('axios');

      const tenantToken = await this.getTenantAccessToken();
      if (!tenantToken) throw new Error('Failed to get tenant access token');

      const url = this.feishuConfig.domain === 'lark'
        ? 'https://open.larksuite.com/open-apis/im/v1/messages'
        : 'https://open.feishu.cn/open-apis/im/v1/messages';

      const response = await axios.post(
        `${url}?receive_id_type=open_id`,
        {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        },
        {
          headers: {
            Authorization: `Bearer ${tenantToken}`,
            'Content-Type': 'application/json',
          },
          timeout: 30000,
        }
      );

      if (response.data.code !== 0) {
        throw new Error(`Feishu API error: ${response.data.msg}`);
      }
    } catch (err) {
      logger.error({ err }, 'Failed to send via Feishu API');
      throw err;
    }
  }

  private async getTenantAccessToken(): Promise<string | null> {
    try {
      const { default: axios } = await import('axios');

      const url = this.feishuConfig.domain === 'lark'
        ? 'https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal'
        : 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal';

      const response = await axios.post(
        url,
        {
          app_id: this.feishuConfig.app_id,
          app_secret: this.feishuConfig.app_secret,
        },
        { timeout: 30000 }
      );

      if (response.data.code === 0) {
        return response.data.tenant_access_token;
      }
      return null;
    } catch (err) {
      logger.error({ err }, 'Failed to get tenant access token');
      return null;
    }
  }

  async sendDelta(chatId: string, delta: string, options?: SendOptions): Promise<void> {
    if (!this.config.streaming) return;

    const streamKey = (options?.metadata?.message_id as string) || chatId;
    const now = Date.now();
    let buf = this.streamBufs.get(streamKey);

    if (!buf) {
      buf = { text: '', cardId: null, sequence: 0, lastEdit: 0 };
      this.streamBufs.set(streamKey, buf);
    }

    buf.text += delta;
    buf.sequence += 1;

    const streamEnd = options?.metadata?.stream_end as boolean;
    const editInterval = 500;

    if (streamEnd) {
      await this.send(chatId, buf.text, options);
      this.streamBufs.delete(streamKey);
    } else if (now - buf.lastEdit >= editInterval) {
      buf.lastEdit = now;
    }
  }

  async handleWebhookEvent(body: Record<string, unknown>): Promise<void> {
    const header = body['header'] as Record<string, unknown>;
    const event = body['event'] as Record<string, unknown>;

    if (!header || !event) return;

    const eventType = header['event_type'] as string;
    if (eventType === 'im.message.receive_v1') {
      await this.handleMessageEvent(event);
    }
  }

  private async handleMessageEvent(event: Record<string, unknown>): Promise<void> {
    const message = event['message'] as Record<string, unknown>;
    const sender = event['sender'] as Record<string, unknown>;

    if (!message || !sender) return;

    const messageId = message['message_id'] as string;
    if (this.processedMessageIds.has(messageId)) return;
    this.processedMessageIds.set(messageId, null);
    if (this.processedMessageIds.size > 500) {
      const firstKey = this.processedMessageIds.keys().next().value;
      if (firstKey) this.processedMessageIds.delete(firstKey);
    }

    const senderId = sender['sender_id'] as Record<string, unknown>;
    const openId = senderId?.['open_id'] as string || 'unknown';

    const chatType = message['chat_type'] as string;
    const chatId = message['chat_id'] as string || openId;

    const msgType = message['message_type'] as string;
    const contentStr = message['content'] as string;
    let content = '';

    try {
      const contentJson = JSON.parse(contentStr);
      if (msgType === 'text') {
        content = contentJson.text || '';
      } else if (msgType === 'post') {
        const { text } = extractPostContent(contentJson);
        content = text;
      } else if (['interactive', 'share_chat', 'share_user', 'system', 'merge_forward'].includes(msgType)) {
        content = extractShareCardContent(contentJson, msgType);
      } else {
        content = MSG_TYPE_MAP[msgType] || `[${msgType}]`;
      }
    } catch {
      content = contentStr;
    }

    if (!content.trim()) return;

    const senderName = (senderId as Record<string, unknown>)?.['name'] as string || 'Unknown';

    if (chatType === 'group' && this.feishuConfig.group_policy === 'mention') {
      if (!content.includes('@_all') && !this.isBotMentioned(message)) {
        return;
      }
      content = this.stripBotMention(content);
    }

    this.publishInbound({
      chat_id: chatId,
      sender_id: openId,
      sender_name: senderName,
      text: content.trim(),
      metadata: {
        message_id: messageId,
        msg_type: msgType,
        chat_type: chatType,
      },
    });
  }

  private isBotMentioned(message: Record<string, unknown>): boolean {
    if (!this.botOpenId) return false;
    const mentions = message['mentions'] as unknown[];
    if (!Array.isArray(mentions)) return false;
    return mentions.some(m => {
      const id = (m as Record<string, unknown>)['id'] as Record<string, unknown>;
      return id?.['open_id'] === this.botOpenId;
    });
  }

  private stripBotMention(text: string): string {
    return text.replace(/@_user_\d+\s*/g, '').trim();
  }
}
