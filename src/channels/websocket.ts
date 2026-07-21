import { WebSocketServer, WebSocket } from 'ws';
import { logger } from '../utils/logger.js';
import { generateId } from '../utils/helpers.js';
import { MessageBus, InboundMessage, OutboundMessage, StreamDeltaEvent, StreamEndEvent, ToolCallEvent } from '../bus/queue.js';
import { BaseChannel, ChannelConfig, SendOptions } from './base.js';

export interface WebSocketChannelConfig extends ChannelConfig {
  host?: string;
  port?: number;
  path?: string;
}

export class WebSocketChannel extends BaseChannel {
  name = 'websocket';
  private server?: WebSocketServer;
  private clients: Map<string, WebSocket> = new Map();
  private extraUnsubscribers: Array<() => void> = [];

  protected get wsConfig(): WebSocketChannelConfig {
    return this.config as WebSocketChannelConfig;
  }

  constructor(bus: MessageBus, config: WebSocketChannelConfig) {
    super(bus, config);
    this.name = config.name || 'websocket';
  }

  async start(): Promise<void> {
    if (this.running) return;

    const host = this.wsConfig.host || '127.0.0.1';
    const port = this.wsConfig.port || 8765;
    const path = this.wsConfig.path || '/ws';

    this.server = new WebSocketServer({
      host,
      port,
      path,
    });

    this.server.on('connection', (ws, req) => {
      const clientId = generateId('client_');
      this.clients.set(clientId, ws);
      
      logger.info({ client_id: clientId, ip: req.socket.remoteAddress }, 'WebSocket client connected');

      ws.on('message', async (data) => {
        try {
          const message = JSON.parse(data.toString());
          await this.handleClientMessage(clientId, message);
        } catch (err) {
          logger.error({ err }, 'Failed to parse WebSocket message');
          this.sendToClient(clientId, {
            type: 'error',
            error: 'Invalid message format',
          });
        }
      });

      ws.on('close', () => {
        this.clients.delete(clientId);
        logger.info({ client_id: clientId }, 'WebSocket client disconnected');
      });

      ws.on('error', (err) => {
        logger.error({ err, client_id: clientId }, 'WebSocket client error');
      });

      this.sendToClient(clientId, {
        type: 'connected',
        client_id: clientId,
      });
    });

    this.subscribeToOutbound();
    this.subscribeToStream();
    this.subscribeToToolEvents();

    this.running = true;
    logger.info({ host, port, path }, 'WebSocket channel started');
  }

  async stop(): Promise<void> {
    if (!this.running) return;

    this.unsubscribeAll();
    for (const unsub of this.extraUnsubscribers) {
      unsub();
    }
    this.extraUnsubscribers = [];

    for (const ws of this.clients.values()) {
      ws.close();
    }
    this.clients.clear();

    await new Promise<void>((resolve) => {
      this.server?.close(() => resolve());
    });

    this.running = false;
    logger.info('WebSocket channel stopped');
  }

  async send(chatId: string, text: string, options?: SendOptions): Promise<void> {
    const message = {
      type: 'message',
      chat_id: chatId,
      text,
      reply_to: options?.reply_to,
      media: options?.media,
      metadata: options?.metadata,
      timestamp: new Date().toISOString(),
    };
    this.sendToClient(chatId, message);
  }

  async sendDelta(chatId: string, delta: string, options?: SendOptions): Promise<void> {
    const message = {
      type: 'stream_delta',
      chat_id: chatId,
      text_delta: delta,
      metadata: options?.metadata,
    };
    this.sendToClient(chatId, message);
  }

  private async handleClientMessage(clientId: string, message: Record<string, unknown>): Promise<void> {
    const type = message.type as string;

    switch (type) {
      case 'message': {
        const chatId = (message.chat_id as string) || clientId;
        const text = message.text as string;
        const senderId = (message.sender_id as string) || 'user';
        
        this.publishInbound({
          chat_id: chatId,
          sender_id: senderId,
          sender_name: message.sender_name as string | undefined,
          text,
          media: message.media as string[] | undefined,
          metadata: message.metadata as Record<string, unknown> | undefined,
          session_key: (message.session_key as string) || `ws:${chatId}`,
        });
        break;
      }
      case 'ping': {
        this.sendToClient(clientId, { type: 'pong', timestamp: new Date().toISOString() });
        break;
      }
      case 'subscribe': {
        const topic = message.topic as string;
        this.sendToClient(clientId, {
          type: 'subscribed',
          topic,
        });
        break;
      }
      default:
        logger.warn({ type }, 'Unknown WebSocket message type');
    }
  }

  private sendToClient(clientId: string, message: Record<string, unknown>): void {
    const ws = this.clients.get(clientId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  private broadcast(message: Record<string, unknown>): void {
    const data = JSON.stringify(message);
    for (const ws of this.clients.values()) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    }
  }

  private subscribeToToolEvents(): void {
    const unsub = this.bus.onToolCall((event) => {
      if (event.channel === this.name) {
        this.broadcast({
          type: 'tool_call',
          ...event,
        });
      }
    });
    this.extraUnsubscribers.push(unsub);
  }

  getClientCount(): number {
    return this.clients.size;
  }
}
