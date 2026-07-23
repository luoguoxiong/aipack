import type { Kobot } from '../kobot';

export interface ChannelConfig {
  id: string;
  name: string;
  enabled: boolean;
}

export interface ChannelMessage {
  id: string;
  channelId: string;
  senderId: string;
  senderName?: string;
  chatId: string;
  content: string;
  media?: string[];
  timestamp: string;
}

export interface ChannelResponse {
  messageId?: string;
  content?: string;
  status: 'success' | 'error';
  error?: string;
}

export interface Channel {
  id: string;
  name: string;
  start(bot: Kobot): Promise<void>;
  stop(): Promise<void>;
  sendMessage(chatId: string, content: string): Promise<ChannelResponse>;
}

export interface CLIConfig extends ChannelConfig {
  historySize?: number;
  prompt?: string;
}

export interface WebhookConfig extends ChannelConfig {
  port: number;
  path: string;
  secret?: string;
}

export interface FeishuConfig extends ChannelConfig {
  appId: string;
  appSecret: string;
  port: number;
  path?: string;
}

export type ChannelConfigMap = {
  cli?: CLIConfig;
  webhook?: WebhookConfig;
  feishu?: FeishuConfig;
};
