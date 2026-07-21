import { logger } from '../utils/logger.js';
import { MessageBus } from '../bus/queue.js';
import { BaseChannel, ChannelConfig, SendOptions } from './base.js';
import { sleep } from '../utils/helpers.js';

export interface WeixinChannelConfig extends ChannelConfig {
  token?: string;
  base_url?: string;
  cdn_base_url?: string;
  route_tag?: string | number;
  state_dir?: string;
  poll_timeout?: number;
}

const ITEM_TEXT = 1;
const ITEM_IMAGE = 2;
const ITEM_VOICE = 3;
const ITEM_FILE = 4;
const ITEM_VIDEO = 5;

const MESSAGE_TYPE_BOT = 2;
const MAX_MESSAGE_LEN = 4000;
const ILINK_APP_ID = 'bot';

export class WeixinChannel extends BaseChannel {
  name = 'weixin';
  private client: unknown = null;
  private token = '';
  private getUpdatesBuf = '';
  private contextTokens: Map<string, string> = new Map();
  private contextTokenAt: Map<string, number> = new Map();
  private processedIds: Map<string, null> = new Map();
  private streamBuffers: Map<string, string[]> = new Map();
  private typingTickets: Map<string, { ticket: string; nextFetchAt: number; retryDelay: number }> = new Map();
  private pollTimer?: NodeJS.Timeout;
  private consecutiveFailures = 0;
  private sessionPauseUntil = 0;

  protected get weixinConfig(): WeixinChannelConfig {
    return this.config as WeixinChannelConfig;
  }

  constructor(bus: MessageBus, config: WeixinChannelConfig) {
    super(bus, config);
    this.name = config.name || 'weixin';
  }

  async start(): Promise<void> {
    if (this.running) return;

    this.running = true;
    this.subscribeToOutbound();
    this.subscribeToStream();

    if (this.weixinConfig.token) {
      this.token = this.weixinConfig.token;
    }

    if (!this.token) {
      logger.warn('Weixin token not configured, channel started but not authenticated');
    }

    this.startPolling();
    logger.info('Weixin channel started');
  }

  private startPolling(): void {
    this.pollTimer = setInterval(() => {
      this.pollOnce().catch(err => {
        logger.error({ err }, 'Weixin poll error');
      });
    }, 2000);
  }

  private async pollOnce(): Promise<void> {
    if (!this.running || !this.token) return;

    const remaining = this.sessionPauseRemaining();
    if (remaining > 0) {
      await sleep(remaining * 1000);
      return;
    }

    try {
      const { default: axios } = await import('axios');
      const baseUrl = this.weixinConfig.base_url || 'https://ilinkai.weixin.qq.com';

      const response = await axios.post(
        `${baseUrl}/ilink/bot/getupdates`,
        {
          get_updates_buf: this.getUpdatesBuf,
          base_info: { channel_version: '2.1.1' },
        },
        {
          headers: this.makeHeaders(),
          timeout: (this.weixinConfig.poll_timeout || 35) * 1000 + 10000,
        }
      );

      const data = response.data;
      const ret = data.ret || 0;
      const errcode = data.errcode || 0;

      if (ret !== 0 || errcode !== 0) {
        if (errcode === -14 || ret === -14) {
          this.pauseSession();
          logger.warn('Weixin session expired, pausing for 1 hour');
          return;
        }
        throw new Error(`getUpdates failed: ret=${ret} errcode=${errcode}`);
      }

      this.consecutiveFailures = 0;

      if (data.get_updates_buf) {
        this.getUpdatesBuf = data.get_updates_buf;
      }

      const msgs = data.msgs || [];
      for (const msg of msgs) {
        try {
          await this.processMessage(msg);
        } catch (err) {
          logger.error({ err }, 'Failed to process Weixin message');
        }
      }
    } catch (err) {
      if (!this.running) return;
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= 3) {
        this.consecutiveFailures = 0;
        await sleep(30000);
      }
    }
  }

  private makeHeaders(auth = true): Record<string, string> {
    const headers: Record<string, string> = {
      'X-WECHAT-UIN': this.randomWechatUin(),
      'Content-Type': 'application/json',
      AuthorizationType: 'ilink_bot_token',
      'iLink-App-Id': ILINK_APP_ID,
      'iLink-App-ClientVersion': '2130701',
    };
    if (auth && this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }
    if (this.weixinConfig.route_tag !== undefined && String(this.weixinConfig.route_tag).trim()) {
      headers['SKRouteTag'] = String(this.weixinConfig.route_tag).trim();
    }
    return headers;
  }

  private randomWechatUin(): string {
    const crypto = require('crypto');
    const uint32 = crypto.randomBytes(4).readUInt32BE(0);
    return Buffer.from(String(uint32)).toString('base64');
  }

  private pauseSession(): void {
    this.sessionPauseUntil = Date.now() + 60 * 60 * 1000;
  }

  private sessionPauseRemaining(): number {
    const remaining = Math.ceil((this.sessionPauseUntil - Date.now()) / 1000);
    if (remaining <= 0) {
      this.sessionPauseUntil = 0;
      return 0;
    }
    return remaining;
  }

  private async processMessage(msg: Record<string, unknown>): Promise<void> {
    if (msg.message_type === MESSAGE_TYPE_BOT) return;

    const msgId = String(msg.message_id || msg.seq || '');
    const fromUserId = msg.from_user_id as string;

    if (!fromUserId || !msgId) return;

    if (this.processedIds.has(msgId)) return;
    this.processedIds.set(msgId, null);
    if (this.processedIds.size > 1000) {
      const firstKey = this.processedIds.keys().next().value;
      if (firstKey) this.processedIds.delete(firstKey);
    }

    const ctxToken = msg.context_token as string;
    if (ctxToken) {
      this.contextTokens.set(fromUserId, ctxToken);
      this.contextTokenAt.set(fromUserId, Date.now());
    }

    const itemList = (msg.item_list || []) as Record<string, unknown>[];
    const contentParts: string[] = [];
    const mediaPaths: string[] = [];

    for (const item of itemList) {
      const itemType = item.type as number;

      if (itemType === ITEM_TEXT) {
        const textItem = (item.text_item || {}) as Record<string, unknown>;
        const text = textItem.text as string;
        if (text) contentParts.push(text);
      } else if (itemType === ITEM_IMAGE) {
        contentParts.push('[image]');
      } else if (itemType === ITEM_VOICE) {
        const voiceItem = (item.voice_item || {}) as Record<string, unknown>;
        const voiceText = voiceItem.text as string;
        if (voiceText) {
          contentParts.push(`[voice] ${voiceText}`);
        } else {
          contentParts.push('[voice]');
        }
      } else if (itemType === ITEM_FILE) {
        const fileItem = (item.file_item || {}) as Record<string, unknown>;
        const fileName = fileItem.file_name as string || 'unknown';
        contentParts.push(`[file: ${fileName}]`);
      } else if (itemType === ITEM_VIDEO) {
        contentParts.push('[video]');
      }
    }

    const content = contentParts.join('\n');
    if (!content.trim()) return;

    this.publishInbound({
      chat_id: fromUserId,
      sender_id: fromUserId,
      sender_name: fromUserId,
      text: content,
      media: mediaPaths.length > 0 ? mediaPaths : undefined,
      metadata: {
        message_id: msgId,
        context_token: ctxToken,
      },
    });
  }

  async stop(): Promise<void> {
    if (!this.running) return;

    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }

    this.unsubscribeAll();
    logger.info('Weixin channel stopped');
  }

  async send(chatId: string, text: string, options?: SendOptions): Promise<void> {
    if (!this.token) {
      throw new Error('Weixin not authenticated');
    }

    const ctxToken = this.contextTokens.get(chatId);
    if (!ctxToken) {
      throw new Error(`Weixin context_token missing for chat_id=${chatId}`);
    }

    try {
      const { default: axios } = await import('axios');
      const baseUrl = this.weixinConfig.base_url || 'https://ilinkai.weixin.qq.com';

      const chunks = this.splitMessage(text, MAX_MESSAGE_LEN);
      for (const chunk of chunks) {
        await axios.post(
          `${baseUrl}/ilink/bot/sendmsg`,
          {
            ilink_user_id: chatId,
            context_token: ctxToken,
            item_list: [
              {
                type: ITEM_TEXT,
                text_item: { text: chunk },
              },
            ],
            base_info: { channel_version: '2.1.1' },
          },
          {
            headers: this.makeHeaders(),
            timeout: 30000,
          }
        );
      }
    } catch (err) {
      logger.error({ err, chat_id: chatId }, 'Failed to send Weixin message');
      throw err;
    }
  }

  private splitMessage(text: string, maxLength: number): string[] {
    if (text.length <= maxLength) return [text];
    const chunks: string[] = [];
    let current = '';
    const lines = text.split('\n');
    for (const line of lines) {
      if (current.length + line.length + 1 > maxLength && current.length > 0) {
        chunks.push(current);
        current = '';
      }
      current += (current ? '\n' : '') + line;
    }
    if (current) chunks.push(current);
    return chunks;
  }

  async sendDelta(chatId: string, delta: string, options?: SendOptions): Promise<void> {
    if (!this.config.streaming) return;

    const streamEnd = options?.metadata?.stream_end as boolean;
    const streamId = (options?.metadata?.stream_id as string) || chatId;

    let buf = this.streamBuffers.get(streamId);
    if (!buf) {
      buf = [];
      this.streamBuffers.set(streamId, buf);
    }

    buf.push(delta);

    if (streamEnd) {
      const fullText = buf.join('');
      this.streamBuffers.delete(streamId);
      await this.send(chatId, fullText, options);
    }
  }
}
