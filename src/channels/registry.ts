import { logger } from '../utils/logger.js';
import { MessageBus } from '../bus/queue.js';
import { BaseChannel, ChannelConfig } from './base.js';
import { registerChannel, createChannel, listRegisteredChannels } from './manager.js';

export type ChannelClass = new (bus: MessageBus, config: ChannelConfig) => BaseChannel;

const _INTERNAL = new Set(['base', 'manager', 'registry', 'index']);

export interface ChannelDiscovery {
  name: string;
  cls: ChannelClass;
}

export function discoverChannelNames(): string[] {
  return listRegisteredChannels();
}

export function loadChannelClass(name: string): ChannelClass | null {
  const factory = (createChannel as unknown as { _registry?: Map<string, unknown> })._registry;
  if (factory) {
    const cls = factory.get(name);
    if (cls) return cls as ChannelClass;
  }
  return null;
}

export function registerChannelClass(name: string, cls: ChannelClass): void {
  registerChannel(name, (bus: MessageBus, config: ChannelConfig) => new cls(bus, config));
  logger.debug({ channel: name }, 'Registered channel class');
}

export function discoverEnabled(enabledNames: Set<string>): Map<string, ChannelClass> {
  const result = new Map<string, ChannelClass>();
  const allNames = listRegisteredChannels();
  for (const name of allNames) {
    if (enabledNames.has(name)) {
      const cls = loadChannelClass(name);
      if (cls) {
        result.set(name, cls);
      }
    }
  }
  return result;
}

export function discoverAll(): Map<string, ChannelClass> {
  const result = new Map<string, ChannelClass>();
  const allNames = listRegisteredChannels();
  for (const name of allNames) {
    const cls = loadChannelClass(name);
    if (cls) {
      result.set(name, cls);
    }
  }
  return result;
}
