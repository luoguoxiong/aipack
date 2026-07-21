import { logger } from '../utils/logger.js';
import { MessageBus } from '../bus/queue.js';
import { BaseChannel, ChannelConfig, SendOptions } from './base.js';

export interface WecomChannelConfig extends ChannelConfig {
  bot_id?: string;
  secret?: string;
  allow_from?: string[];
  welcome_message?: string;
}

const MSG_TYPE_MAP: Record<string, string> = {
  image: '[image]',
  voice: '[voice]',
  file: '[file]',
  mixed: '[mixed content]',
};

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);
const VIDEO_EXTS = new Set(['.mp4', '.avi', '.mov']);
const AUDIO_EXTS = new Set(['.amr', '.mp3', '.wav', '.ogg']);

function guessWecomMediaType(filename: string): string {
  const ext = filename.toLowerCase().slice(filename.lastIndexOf('.'));
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (AUDIO_EXTS.has(ext)) return 'voice';
  return 'file';
}

function sanitizeFilename(name: string): string {
  name = name.trim();
  name = name.split(/[\\/]/).pop() || name;
  name = name.replace(/[^\w.\-()\[\]（）【】\u4e00-\u9fff]+/g, '_').replace(/^[._\s]+|[._\s]+$/g, '');
  return name || 'file';
}

export class WecomChannel extends BaseChannel {
  name = 'wecom';
  private client: unknown = null;
  private processedMessageIds: Map<string, null> = new Map();
  private chatFrames: Map<string, unknown> = new Map();
  private keepAliveTimer?: NodeJS.Timeout;

  protected get wecomConfig(): WecomChannelConfig {
    return this.config as WecomChannelConfig;
  }

  constructor(bus: MessageBus, config: WecomChannelConfig) {
    super(bus, config);
    this.name = config.name || 'wecom';
  }

  async start(): Promise<void> {
    if (this.running) return;

    const { bot_id, secret } = this.wecomConfig;
    if (!bot_id || !secret) {
      logger.warn('Wecom bot_id and secret not configured, channel disabled');
      return;
    }

    this.subscribeToOutbound();
    this.subscribeToStream();

    try {
      await this.connectWebSocket();
    } catch (err) {
      logger.error({ err }, 'Failed to connect Wecom WebSocket, falling back to API mode');
    }

    this.running = true;
    logger.info('Wecom channel started');
  }

  private async connectWebSocket(): Promise<void> {
    try {
      // @ts-ignore - dynamic import
      const wecomSdk = await import('wecom_aibot_sdk');
      const { WSClient, generateReqId } = wecomSdk;

      this.client = new WSClient({
        bot_id: this.wecomConfig.bot_id,
        secret: this.wecomConfig.secret,
        reconnect_interval: 1000,
        max_reconnect_attempts: -1,
        heartbeat_interval: 30000,
      });

      const client = this.client as Record<string, unknown>;
      if (typeof client['on'] === 'function') {
        client['on']('connected', this.onConnected.bind(this));
        client['on']('authenticated', this.onAuthenticated.bind(this));
        client['on']('disconnected', this.onDisconnected.bind(this));
        client['on']('error', this.onError.bind(this));
        client['on']('message.text', this.onTextMessage.bind(this));
        client['on']('message.image', this.onImageMessage.bind(this));
        client['on']('message.voice', this.onVoiceMessage.bind(this));
        client['on']('message.file', this.onFileMessage.bind(this));
        client['on']('message.mixed', this.onMixedMessage.bind(this));
        client['on']('event.enter_chat', this.onEnterChat.bind(this));
      }

      if (typeof client['connect_async'] === 'function') {
        await client['connect_async']();
      }

      logger.info('Wecom WebSocket connected');
    } catch (err) {
      logger.debug({ err }, 'Wecom SDK not available');
    }
  }

  private onConnected(frame: unknown): void {
    logger.info('Wecom WebSocket connected');
  }

  private onAuthenticated(frame: unknown): void {
    logger.info('Wecom authenticated successfully');
  }

  private onDisconnected(frame: unknown): void {
    logger.warn('Wecom WebSocket disconnected');
  }

  private onError(frame: unknown): void {
    logger.error({ frame }, 'Wecom WebSocket error');
  }

  private async onTextMessage(frame: unknown): Promise<void> {
    await this.processMessage(frame, 'text');
  }

  private async onImageMessage(frame: unknown): Promise<void> {
    await this.processMessage(frame, 'image');
  }

  private async onVoiceMessage(frame: unknown): Promise<void> {
    await this.processMessage(frame, 'voice');
  }

  private async onFileMessage(frame: unknown): Promise<void> {
    await this.processMessage(frame, 'file');
  }

  private async onMixedMessage(frame: unknown): Promise<void> {
    await this.processMessage(frame, 'mixed');
  }

  private async onEnterChat(frame: unknown): Promise<void> {
    try {
      const body = this.extractBody(frame);
      const chatId = body.chatid as string || '';
      if (chatId && this.wecomConfig.welcome_message) {
        const client = this.client as Record<string, unknown>;
        if (client && typeof client['reply_welcome'] === 'function') {
          await client['reply_welcome'](frame, {
            msgtype: 'text',
            text: { content: this.wecomConfig.welcome_message },
          });
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error handling enter_chat');
    }
  }

  private extractBody(frame: unknown): Record<string, unknown> {
    if (!frame) return {};
    if (typeof frame === 'object') {
      const f = frame as Record<string, unknown>;
      if (f.body && typeof f.body === 'object') return f.body as Record<string, unknown>;
      if (f.body === undefined && 'msgid' in f) return f;
    }
    return {};
  }

  private async processMessage(frame: unknown, msgType: string): Promise<void> {
    try {
      const body = this.extractBody(frame);
      const msgId = body.msgid as string || `${body.chatid}_${body.sendertime}`;

      if (!msgId) return;

      if (this.processedMessageIds.has(msgId)) return;
      this.processedMessageIds.set(msgId, null);
      if (this.processedMessageIds.size > 1000) {
        const firstKey = this.processedMessageIds.keys().next().value;
        if (firstKey) this.processedMessageIds.delete(firstKey);
      }

      const fromInfo = body.from as Record<string, unknown>;
      const senderId = fromInfo?.userid as string || 'unknown';

      const chatType = body.chattype as string || 'single';
      const chatId = body.chatid as string || senderId;

      const contentParts: string[] = [];
      const mediaPaths: string[] = [];

      if (msgType === 'text') {
        const text = (body.text as Record<string, unknown>)?.content as string || '';
        if (text) contentParts.push(text);
      } else if (msgType === 'image') {
        contentParts.push('[image]');
      } else if (msgType === 'voice') {
        const voice = body.voice as Record<string, unknown>;
        const voiceContent = voice?.content as string;
        if (voiceContent) {
          contentParts.push(`[voice] ${voiceContent}`);
        } else {
          contentParts.push('[voice]');
        }
      } else if (msgType === 'file') {
        const file = body.file as Record<string, unknown>;
        const fileName = file?.name as string || 'unknown';
        contentParts.push(`[file: ${fileName}]`);
      } else if (msgType === 'mixed') {
        const mixed = body.mixed as Record<string, unknown>;
        const msgItems = (mixed?.msg_item || []) as Record<string, unknown>[];
        for (const item of msgItems) {
          const itemType = item.msgtype as string;
          if (itemType === 'text') {
            const text = (item.text as Record<string, unknown>)?.content as string || '';
            if (text) contentParts.push(text);
          } else if (itemType === 'image') {
            contentParts.push('[image]');
          } else {
            contentParts.push(MSG_TYPE_MAP[itemType] || `[${itemType}]`);
          }
        }
      } else {
        contentParts.push(MSG_TYPE_MAP[msgType] || `[${msgType}]`);
      }

      const content = contentParts.join('\n');
      if (!content.trim()) return;

      this.chatFrames.set(chatId, frame);

      this.publishInbound({
        chat_id: chatId,
        sender_id: senderId,
        sender_name: senderId,
        text: content,
        media: mediaPaths.length > 0 ? mediaPaths : undefined,
        metadata: {
          message_id: msgId,
          msg_type: msgType,
          chat_type: chatType,
        },
      });
    } catch (err) {
      logger.error({ err }, 'Error processing Wecom message');
    }
  }

  async stop(): Promise<void> {
    if (!this.running) return;

    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = undefined;
    }

    const client = this.client as Record<string, unknown> | null;
    if (client && typeof client['disconnect'] === 'function') {
      try {
        await client['disconnect']();
      } catch (err) {
        logger.debug({ err }, 'Error disconnecting Wecom client');
      }
    }

    this.unsubscribeAll();
    this.running = false;
    logger.info('Wecom channel stopped');
  }

  async send(chatId: string, text: string, options?: SendOptions): Promise<void> {
    try {
      const frame = this.chatFrames.get(chatId);
      const client = this.client as Record<string, unknown> | null;

      if (frame && client && typeof client['reply_stream'] === 'function') {
        const { default: crypto } = await import('crypto');
        const streamId = crypto.randomUUID();
        await client['reply_stream'](frame, streamId, text, { finish: true });
      } else if (client && typeof client['send_message'] === 'function') {
        await client['send_message'](chatId, {
          msgtype: 'markdown',
          markdown: { content: text },
        });
      } else {
        await this.sendViaApi(chatId, text);
      }
    } catch (err) {
      logger.error({ err, chat_id: chatId }, 'Failed to send Wecom message');
      throw err;
    }
  }

  private async sendViaApi(chatId: string, text: string): Promise<void> {
    const { default: axios } = await import('axios');
    const accessToken = await this.getAccessToken();
    if (!accessToken) throw new Error('Failed to get Wecom access token');

    const response = await axios.post(
      'https://qyapi.weixin.qq.com/cgi-bin/appchat/send',
      {
        access_token: accessToken,
        chatid: chatId,
        msgtype: 'text',
        text: { content: text },
        safe: 0,
      },
      { params: { access_token: accessToken }, timeout: 30000 }
    );

    if (response.data.errcode !== 0) {
      throw new Error(`Wecom API error: ${response.data.errmsg}`);
    }
  }

  private async getAccessToken(): Promise<string | null> {
    try {
      const { default: axios } = await import('axios');
      const response = await axios.get('https://qyapi.weixin.qq.com/cgi-bin/gettoken', {
        params: {
          corpid: this.wecomConfig.bot_id,
          corpsecret: this.wecomConfig.secret,
        },
        timeout: 30000,
      });
      if (response.data.errcode === 0) {
        return response.data.access_token;
      }
      return null;
    } catch (err) {
      logger.error({ err }, 'Failed to get Wecom access token');
      return null;
    }
  }

  async sendDelta(chatId: string, delta: string, options?: SendOptions): Promise<void> {
    if (!this.config.streaming) return;
  }
}
