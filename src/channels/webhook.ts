import http from 'http';
import type { Channel, WebhookConfig, ChannelMessage, ChannelResponse } from './types';
import type { Kobot } from '../kobot';
import { STREAM_EVENT_TEXT_DELTA, STREAM_EVENT_TEXT_COMPLETED, STREAM_EVENT_TOOL_STARTED, STREAM_EVENT_TOOL_COMPLETED, STREAM_EVENT_TOOL_FAILED, STREAM_EVENT_RUN_COMPLETED, STREAM_EVENT_RUN_FAILED } from '../kobot';

export class WebhookChannel implements Channel {
  id: string;
  name: string;
  private config: WebhookConfig;
  private server: http.Server | null = null;
  private bot: Kobot | null = null;

  constructor(config: WebhookConfig) {
    this.id = config.id;
    this.name = config.name;
    this.config = config;
  }

  async start(bot: Kobot): Promise<void> {
    this.bot = bot;

    this.server = http.createServer(async (req, res) => {
      if (req.url !== this.config.path) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      if (req.method !== 'POST') {
        res.writeHead(405);
        res.end('Method not allowed');
        return;
      }

      if (this.config.secret) {
        const authHeader = req.headers['authorization'];
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
          res.writeHead(401);
          res.end('Unauthorized');
          return;
        }
        const token = authHeader.slice(7);
        if (token !== this.config.secret) {
          res.writeHead(403);
          res.end('Forbidden');
          return;
        }
      }

      try {
        const body = await this.readBody(req);
        const message = JSON.parse(body) as Partial<ChannelMessage>;
        
        if (!message.content || !message.chatId || !message.senderId) {
          res.writeHead(400);
          res.end('Missing required fields');
          return;
        }

        const response = await this.handleMessage({
          id: message.id || Date.now().toString(),
          channelId: this.id,
          senderId: message.senderId,
          senderName: message.senderName,
          chatId: message.chatId,
          content: message.content,
          media: message.media,
          timestamp: message.timestamp || new Date().toISOString(),
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', error: (err as Error).message }));
      }
    });

    return new Promise((resolve) => {
      this.server!.listen(this.config.port, () => {
        console.log(`🌐 ${this.name} webhook started on http://localhost:${this.config.port}${this.config.path}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (this.server) {
      return new Promise((resolve) => {
        this.server!.close(() => {
          console.log(`🌐 ${this.name} webhook stopped`);
          resolve();
        });
      });
    }
    if (this.bot) {
      await this.bot.close();
    }
  }

  async sendMessage(chatId: string, content: string): Promise<ChannelResponse> {
    return { status: 'success', content };
  }

  private async readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        resolve(body);
      });
      req.on('error', reject);
    });
  }

  private async handleMessage(message: ChannelMessage): Promise<ChannelResponse> {
    if (!this.bot) {
      return { status: 'error', error: 'Bot not initialized' };
    }

    try {
      const sessionKey = `webhook:${message.channelId}:${message.chatId}`;
      let finalContent = '';

      for await (const event of this.bot.stream(message.content, {
        sessionKey,
        channel: message.channelId,
        chatId: message.chatId,
        senderId: message.senderId,
      })) {
        switch (event.type) {
          case STREAM_EVENT_TEXT_DELTA:
            finalContent += event.content || '';
            break;
          case STREAM_EVENT_TEXT_COMPLETED:
            finalContent = event.content || finalContent;
            break;
        }
      }

      return {
        status: 'success',
        content: finalContent,
        messageId: Date.now().toString(),
      };
    } catch (err) {
      return { status: 'error', error: (err as Error).message };
    }
  }
}

export function createWebhookChannel(config: WebhookConfig): WebhookChannel {
  return new WebhookChannel(config);
}
