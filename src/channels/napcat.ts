import { BaseChannel } from './base.js';
import type { ChannelConfig, SendOptions } from './base.js';
import { MessageBus } from '../bus/queue.js';

export interface NapCatConfig extends ChannelConfig {
  napcat_url?: string;
  qq_id?: string;
  ws_url?: string;
}

export class NapCatChannel extends BaseChannel {
  name = 'napcat';

  constructor(bus: MessageBus, config: NapCatConfig) {
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