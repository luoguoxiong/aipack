import { logger } from '../utils/logger.js';
import { MessageBus, InboundMessage, OutboundMessage } from '../bus/queue.js';
import { generateId } from '../utils/helpers.js';

export interface ChannelConfig {
  name: string;
  enabled?: boolean;
  streaming?: boolean;
  [key: string]: unknown;
}

export interface SendOptions {
  reply_to?: string;
  media?: string[];
  metadata?: Record<string, unknown>;
}

export abstract class BaseChannel {
  abstract name: string;
  protected bus: MessageBus;
  protected config: ChannelConfig;
  protected running = false;
  private unsubscribers: Array<() => void> = [];

  constructor(bus: MessageBus, config: ChannelConfig) {
    this.bus = bus;
    this.config = config;
  }

  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;
  abstract send(chatId: string, text: string, options?: SendOptions): Promise<void>;
  abstract sendDelta(chatId: string, delta: string, options?: SendOptions): Promise<void>;

  protected publishInbound(message: Omit<InboundMessage, 'id' | 'timestamp' | 'channel'>): void {
    const inbound: InboundMessage = {
      id: generateId('msg_'),
      channel: this.name,
      timestamp: new Date().toISOString(),
      ...message,
    };
    this.bus.publish({ type: 'inbound_message', payload: inbound });
    logger.debug({ channel: this.name, chat_id: message.chat_id }, 'Published inbound message');
  }

  protected subscribeToOutbound(): void {
    const unsub = this.bus.onOutboundMessage(async (msg) => {
      if (msg.channel === this.name) {
        try {
          await this.send(msg.chat_id, msg.text, {
            reply_to: msg.reply_to,
            media: msg.media,
            metadata: msg.metadata,
          });
        } catch (err) {
          logger.error({ err, channel: this.name }, 'Failed to send outbound message');
        }
      }
    });
    this.unsubscribers.push(unsub);
  }

  protected subscribeToStream(): void {
    if (!this.config.streaming) return;

    const unsub = this.bus.onStreamDelta(async (event) => {
      if (event.channel === this.name) {
        try {
          await this.sendDelta(event.chat_id, event.text_delta, {
            metadata: event.metadata,
          });
        } catch (err) {
          logger.debug({ err, channel: this.name }, 'Failed to send stream delta');
        }
      }
    });
    this.unsubscribers.push(unsub);
  }

  protected unsubscribeAll(): void {
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];
  }

  isRunning(): boolean {
    return this.running;
  }

  getConfig(): ChannelConfig {
    return this.config;
  }
}
