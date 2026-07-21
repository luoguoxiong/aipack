import { logger } from '../utils/logger.js';

export interface ChannelConnection {
  channel: string;
  chatId: string;
  connected: boolean;
  connectedAt?: string;
  lastMessageAt?: string;
}

export class ChannelConnectManager {
  private connections: Map<string, ChannelConnection> = new Map();

  connect(channel: string, chatId: string): ChannelConnection {
    const key = `${channel}:${chatId}`;
    const connection: ChannelConnection = {
      channel,
      chatId,
      connected: true,
      connectedAt: new Date().toISOString(),
    };
    this.connections.set(key, connection);
    logger.info({ channel, chatId }, 'Channel connected');
    return connection;
  }

  disconnect(channel: string, chatId: string): boolean {
    const key = `${channel}:${chatId}`;
    const connection = this.connections.get(key);
    if (connection) {
      connection.connected = false;
      logger.info({ channel, chatId }, 'Channel disconnected');
      return true;
    }
    return false;
  }

  get(channel: string, chatId: string): ChannelConnection | undefined {
    return this.connections.get(`${channel}:${chatId}`);
  }

  list(): ChannelConnection[] {
    return Array.from(this.connections.values());
  }

  updateLastMessage(channel: string, chatId: string): void {
    const key = `${channel}:${chatId}`;
    const connection = this.connections.get(key);
    if (connection) {
      connection.lastMessageAt = new Date().toISOString();
    }
  }
}
