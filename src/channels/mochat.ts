import { BaseChannel } from './base.js';
import type { ChannelConfig, SendOptions } from './base.js';
import { MessageBus } from '../bus/queue.js';

export interface MoChatConfig extends ChannelConfig {
  bot_id?: string;
  api_key?: string;
  endpoint?: string;
}

export class MoChatChannel extends BaseChannel {
  name = 'mochat';

  constructor(bus: MessageBus, config: MoChatConfig) {
    super(bus, config);
  }

  async start(): Promise<void> {
    // Implementation needed
  }

  async stop(): Promise<void> {
    // Implementation needed
  }

  async send(chatId: string, text: string, options?: SendOptions): Promise<void> {
    // Implementation needed
  }

  async sendDelta(chatId: string, delta: string, options?: SendOptions): Promise<void> {
    // Implementation needed
  }
}