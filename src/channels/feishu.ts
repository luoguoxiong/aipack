import express from 'express';
import type { Application, Request, Response } from 'express';
import http from 'http';
import axios from 'axios';
import type { Channel, FeishuConfig, ChannelResponse } from './types';
import type { Kobot } from '../kobot';

export class FeishuChannel implements Channel {
  id: string;
  name: string;
  private config: FeishuConfig;
  private app: Application;
  private server: http.Server | null = null;
  private bot: Kobot | null = null;
  private tenantAccessToken = '';
  private tokenExpireAt = 0;

  constructor(config: FeishuConfig) {
    this.id = config.id;
    this.name = config.name;
    this.config = config;
    this.app = express();

    this.app.use(express.json());

    this.app.post(this.config.path || '/webhook/event', async (req: Request, res: Response) => {
      await this.handleEventCallback(req, res);
    });

    // 同时处理根路径的 POST（以防飞书发送到根 URL）
    this.app.post('/', async (req: Request, res: Response) => {
      await this.handleEventCallback(req, res);
    });

    this.app.get('/health', (_req: Request, res: Response) => {
      res.json({ status: 'ok' });
    });

    this.app.get('/', (_req: Request, res: Response) => {
      res.json({ service: this.name, status: 'running' });
    });
  }

  async start(bot: Kobot): Promise<void> {
    this.bot = bot;

    return new Promise((resolve) => {
      this.server = this.app.listen(this.config.port, () => {
        console.log(`💬 [${this.name}] Feishu channel started on http://localhost:${this.config.port}${this.config.path || '/webhook/event'}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (this.server) {
      return new Promise((resolve) => {
        this.server!.close(() => resolve());
      });
    }
  }

  async sendMessage(chatId: string, content: string): Promise<ChannelResponse> {
    try {
      const token = await this.getTenantAccessToken();
      const body = {
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text: content }),
      };

      await axios.post('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', body, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      });
      return { status: 'success' };
    } catch (err) {
      return { status: 'error', error: (err as Error).message };
    }
  }

  private async handleEventCallback(req: Request, res: Response): Promise<void> {
    try {
      const body = req.body;

      console.log(`🔍 [${this.name}] Received request:`, {
        method: req.method,
        url: req.url,
        contentType: req.headers['content-type'],
        body: JSON.stringify(body).slice(0, 200),
      });

      // URL 验证挑战
      if (body.type === 'url_verification') {
        res.json({ challenge: body.challenge });
        return;
      }

      // 消息事件
      if (body.header?.event_type === 'im.message.receive_v1') {
        res.json({ code: 0 });

        // 异步处理
        this.handleMessageEvent(body.event).catch((err) => {
          console.error(`❌ [${this.name}] Message handler error:`, err);
        });
        return;
      }

      // 其他事件类型
      res.json({ code: 0 });
    } catch (err) {
      console.error(`❌ [${this.name}] Event callback error:`, err);
      res.status(500).json({ code: 500, msg: '内部错误' });
    }
  }

  private async getTenantAccessToken(): Promise<string> {
    if (this.tenantAccessToken && Date.now() < this.tokenExpireAt) {
      return this.tenantAccessToken;
    }

    const res = await axios.post(
      'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
      { app_id: this.config.appId, app_secret: this.config.appSecret },
      { timeout: 10000 },
    );

    if (res.data.code !== 0) {
      throw new Error(`Feishu auth failed (${res.data.code}): ${res.data.msg}`);
    }

    this.tenantAccessToken = res.data.tenant_access_token;
    this.tokenExpireAt = Date.now() + (res.data.expire - 300) * 1000;

    return this.tenantAccessToken;
  }

  private async handleMessageEvent(event: any): Promise<void> {
    if (!this.bot) {
      console.error(`❌ [${this.name}] 机器人未初始化`);
      return;
    }

    const message = event.message;
    const sender = event.sender;

    if (!message || !sender) return;

    const messageId = message.message_id;
    const chatId = message.chat_id;
    const chatType = message.chat_type; // "p2p" 或 "group"
    const senderId = sender.sender_id?.open_id;
    const senderName = sender.sender_id?.name || '';
    const messageType = message.message_type;

    // 只处理文本消息
    if (messageType !== 'text') return;

    const content = JSON.parse(message.content || '{}');
    const text = (content.text || '').trim();

    if (!text) return;

    const sessionKey = `feishu:${chatId}`;

    console.log(`💬 [${this.name}] ${chatType}:${chatId} < ${text.slice(0, 100)}`);

    let replyContent = '';
    try {
      for await (const event of this.bot.stream(text, {
        sessionKey,
        channel: this.id,
        chatId,
        senderId,
      })) {
        if (event.type === 'text_chunk') {
          replyContent += event.content || '';
        } else if (event.type === 'text_finished') {
          replyContent = event.content || replyContent;
        }
      }

      if (!replyContent) return;

      const token = await this.getTenantAccessToken();
      await this.replyToMessage(messageId, replyContent, token);
      console.log(`💬 [${this.name}] ${chatType}:${chatId} > ${replyContent.slice(0, 100)}`);
    } catch (err) {
      console.error(`❌ [${this.name}] Processing error:`, err);
      const token = await this.getTenantAccessToken();
      await this.replyToMessage(messageId, `😅 处理出错: ${(err as Error).message}`, token);
    }
  }

  private async replyToMessage(messageId: string, content: string, token: string): Promise<void> {
    // 飞书文本格式支持换行和基本内容
    // 注意：飞书富文本格式不支持 markdown 标签
    const body = {
      msg_type: 'text',
      content: JSON.stringify({ text: content }),
    };

    await axios.post(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/reply`, body, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    });
  }
}

export function createFeishuChannel(config: FeishuConfig): FeishuChannel {
  return new FeishuChannel(config);
}
