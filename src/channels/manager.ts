import { logger } from '../utils/logger.js';
import { MessageBus } from '../bus/queue.js';
import { BaseChannel, ChannelConfig } from './base.js';

export type ChannelFactory = (bus: MessageBus, config: ChannelConfig) => BaseChannel;

const channelRegistry: Map<string, ChannelFactory> = new Map();

export function registerChannel(name: string, factory: ChannelFactory): void {
  channelRegistry.set(name, factory);
  logger.debug({ channel: name }, 'Registered channel');
}

export function createChannel(name: string, bus: MessageBus, config: ChannelConfig): BaseChannel | null {
  const factory = channelRegistry.get(name);
  if (!factory) {
    return null;
  }
  return factory(bus, config);
}

export function listRegisteredChannels(): string[] {
  return Array.from(channelRegistry.keys());
}

export class ChannelManager {
  private bus: MessageBus;
  private channels: Map<string, BaseChannel> = new Map();

  constructor(bus: MessageBus) {
    this.bus = bus;
  }

  register(name: string, channel: BaseChannel): void {
    this.channels.set(name, channel);
    logger.debug({ channel: name }, 'Channel added to manager');
  }

  get(name: string): BaseChannel | undefined {
    return this.channels.get(name);
  }

  has(name: string): boolean {
    return this.channels.has(name);
  }

  list(): string[] {
    return Array.from(this.channels.keys());
  }

  async startAll(): Promise<void> {
    for (const [name, channel] of this.channels) {
      if (channel.getConfig().enabled === false) {
        logger.debug({ channel: name }, 'Skipping disabled channel');
        continue;
      }
      try {
        await channel.start();
        logger.info({ channel: name }, 'Channel started');
      } catch (err) {
        logger.error({ err, channel: name }, 'Failed to start channel');
      }
    }
  }

  async stopAll(): Promise<void> {
    for (const [name, channel] of this.channels) {
      try {
        await channel.stop();
        logger.info({ channel: name }, 'Channel stopped');
      } catch (err) {
        logger.error({ err, channel: name }, 'Failed to stop channel');
      }
    }
  }

  async loadFromConfig(channelsConfig: Record<string, ChannelConfig>): Promise<void> {
    for (const [name, config] of Object.entries(channelsConfig)) {
      const channel = createChannel(name, this.bus, { ...config, name });
      if (channel) {
        this.register(name, channel);
      } else {
        logger.debug({ channel: name }, 'No registered factory for channel type');
      }
    }
  }
}
