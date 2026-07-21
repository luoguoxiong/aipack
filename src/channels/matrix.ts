import { logger } from '../utils/logger.js';
import { MessageBus } from '../bus/queue.js';
import { BaseChannel, ChannelConfig, SendOptions } from './base.js';

export interface MatrixChannelConfig extends ChannelConfig {
  homeserver_url?: string;
  user_id?: string;
  access_token?: string;
  device_id?: string;
  display_name?: string;
  store_path?: string;
  allow_from?: string[];
}

type MatrixClient = {
  on: (event: string, handler: (event: unknown, room: unknown) => void) => void;
  startClient: () => Promise<void>;
  stopClient: () => void;
  setDisplayName: (name: string) => Promise<void>;
  sendTextMessage?: (roomId: string, text: string) => Promise<unknown>;
  sendMessage?: (roomId: string, content: Record<string, unknown>) => Promise<unknown>;
};

export class MatrixChannel extends BaseChannel {
  name = 'matrix';
  private client: MatrixClient | null = null;
  private processedMessageIds: Set<string> = new Set();
  private streamBuffers: Map<string, string> = new Map();

  protected get matrixConfig(): MatrixChannelConfig {
    return this.config as MatrixChannelConfig;
  }

  constructor(bus: MessageBus, config: MatrixChannelConfig) {
    super(bus, config);
    this.name = config.name || 'matrix';
  }

  async start(): Promise<void> {
    if (this.running) return;

    const { homeserver_url, user_id, access_token } = this.matrixConfig;
    if (!homeserver_url || !user_id || !access_token) {
      logger.warn('Matrix homeserver_url, user_id, and access_token required, channel disabled');
      return;
    }

    this.subscribeToOutbound();
    this.subscribeToStream();

    try {
      await this.initializeClient();
    } catch (err) {
      logger.error({ err }, 'Failed to initialize Matrix client');
    }

    this.running = true;
    logger.info('Matrix channel started');
  }

  private async initializeClient(): Promise<void> {
    try {
      // @ts-ignore - dynamic import
      const matrixSdk = await import('matrix-js-sdk');

      const storePath = this.matrixConfig.store_path || './.matrix-store';

      const client = matrixSdk.createClient({
        baseUrl: this.matrixConfig.homeserver_url,
        userId: this.matrixConfig.user_id,
        accessToken: this.matrixConfig.access_token,
        deviceId: this.matrixConfig.device_id,
        storePath,
      }) as MatrixClient;

      this.client = client;

      const RoomEvent = matrixSdk.RoomEvent?.Message || 'Room.timeline';
      client.on(RoomEvent, (event: unknown, room: unknown) => {
        this.handleMessage(event, room).catch(err => {
          logger.error({ err }, 'Error handling Matrix message');
        });
      });

      await client.startClient();
      logger.info('Matrix client started');

      if (this.matrixConfig.display_name) {
        try {
          await client.setDisplayName(this.matrixConfig.display_name);
        } catch (err) {
          logger.warn({ err }, 'Failed to set Matrix display name');
        }
      }
    } catch (err) {
      logger.debug({ err }, 'matrix-js-sdk not available, install it for Matrix channel');
    }
  }

  private async handleMessage(event: unknown, room: unknown): Promise<void> {
    try {
      const ev = event as Record<string, unknown>;
      const roomObj = room as Record<string, unknown>;

      const getSender = ev.getSender as (() => string) | undefined;
      const getId = ev.getId as (() => string) | undefined;
      const getRoomId = ev.getRoomId as (() => string) | undefined;
      const getContent = ev.getContent as (() => Record<string, unknown>) | undefined;

      const sender = getSender ? getSender() : (ev.sender as string);
      const eventId = getId ? getId() : (ev.event_id as string);
      const roomId = roomObj.roomId as string || (getRoomId ? getRoomId() : '');

      if (!eventId || this.processedMessageIds.has(eventId)) return;
      this.processedMessageIds.add(eventId);
      if (this.processedMessageIds.size > 1000) {
        const first = this.processedMessageIds.values().next().value;
        if (first) this.processedMessageIds.delete(first);
      }

      if (sender === this.matrixConfig.user_id) return;

      const content = getContent ? getContent() : (ev.content as Record<string, unknown>);
      const msgType = content?.msgtype as string;
      const body = content?.body as string || '';

      if (msgType !== 'm.text' || !body.trim()) return;

      const senderName = sender;

      this.publishInbound({
        chat_id: roomId,
        sender_id: sender,
        sender_name: senderName,
        text: body,
        metadata: {
          event_id: eventId,
          room_id: roomId,
        },
      });
    } catch (err) {
      logger.error({ err }, 'Error handling Matrix message');
    }
  }

  async stop(): Promise<void> {
    if (!this.running) return;

    if (this.client) {
      try {
        this.client.stopClient();
      } catch (err) {
        logger.debug({ err }, 'Error stopping Matrix client');
      }
    }

    this.client = null;
    this.unsubscribeAll();
    this.running = false;
    logger.info('Matrix channel stopped');
  }

  async send(chatId: string, text: string, options?: SendOptions): Promise<void> {
    if (!this.client) {
      throw new Error('Matrix client not initialized');
    }

    try {
      const client = this.client;

      if (client.sendTextMessage) {
        await client.sendTextMessage(chatId, text);
      } else if (client.sendMessage) {
        await client.sendMessage(chatId, {
          msgtype: 'm.text',
          body: text,
        });
      }
    } catch (err) {
      logger.error({ err, chat_id: chatId }, 'Failed to send Matrix message');
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
