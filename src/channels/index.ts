import { MessageBus } from '../bus/queue.js';
import { BaseChannel, ChannelConfig } from './base.js';
import { ChannelManager, registerChannel } from './manager.js';
import { WebSocketChannel, WebSocketChannelConfig } from './websocket.js';
import { CliChannel } from './cli.js';
import { TelegramChannel, TelegramChannelConfig } from './telegram.js';
import { DiscordChannel, DiscordChannelConfig } from './discord.js';
import { SlackChannel, SlackChannelConfig } from './slack.js';
import { FeishuChannel, FeishuChannelConfig } from './feishu.js';
import { WeixinChannel, WeixinChannelConfig } from './weixin.js';
import { WecomChannel, WecomChannelConfig } from './wecom.js';
import { QQChannel, QQChannelConfig } from './qq.js';
import { DingTalkChannel, DingTalkChannelConfig } from './dingtalk.js';
import { EmailChannel, EmailChannelConfig } from './email.js';
import { WhatsAppChannel, WhatsAppChannelConfig } from './whatsapp.js';
import { SignalChannel, SignalChannelConfig } from './signal.js';
import { MatrixChannel, MatrixChannelConfig } from './matrix.js';
import { MattermostChannel, MattermostChannelConfig } from './mattermost.js';
import { MSTeamsChannel, MSTeamsChannelConfig } from './msteams.js';

registerChannel('websocket', (bus: MessageBus, config: ChannelConfig) => {
  return new WebSocketChannel(bus, config as WebSocketChannelConfig);
});

registerChannel('cli', (bus: MessageBus, config: ChannelConfig) => {
  return new CliChannel(bus, config);
});

registerChannel('telegram', (bus: MessageBus, config: ChannelConfig) => {
  return new TelegramChannel(bus, config as TelegramChannelConfig);
});

registerChannel('discord', (bus: MessageBus, config: ChannelConfig) => {
  return new DiscordChannel(bus, config as DiscordChannelConfig);
});

registerChannel('slack', (bus: MessageBus, config: ChannelConfig) => {
  return new SlackChannel(bus, config as SlackChannelConfig);
});

registerChannel('feishu', (bus: MessageBus, config: ChannelConfig) => {
  return new FeishuChannel(bus, config as FeishuChannelConfig);
});

registerChannel('weixin', (bus: MessageBus, config: ChannelConfig) => {
  return new WeixinChannel(bus, config as WeixinChannelConfig);
});

registerChannel('wecom', (bus: MessageBus, config: ChannelConfig) => {
  return new WecomChannel(bus, config as WecomChannelConfig);
});

registerChannel('qq', (bus: MessageBus, config: ChannelConfig) => {
  return new QQChannel(bus, config as QQChannelConfig);
});

registerChannel('dingtalk', (bus: MessageBus, config: ChannelConfig) => {
  return new DingTalkChannel(bus, config as DingTalkChannelConfig);
});

registerChannel('email', (bus: MessageBus, config: ChannelConfig) => {
  return new EmailChannel(bus, config as EmailChannelConfig);
});

registerChannel('whatsapp', (bus: MessageBus, config: ChannelConfig) => {
  return new WhatsAppChannel(bus, config as WhatsAppChannelConfig);
});

registerChannel('signal', (bus: MessageBus, config: ChannelConfig) => {
  return new SignalChannel(bus, config as SignalChannelConfig);
});

registerChannel('matrix', (bus: MessageBus, config: ChannelConfig) => {
  return new MatrixChannel(bus, config as MatrixChannelConfig);
});

registerChannel('mattermost', (bus: MessageBus, config: ChannelConfig) => {
  return new MattermostChannel(bus, config as MattermostChannelConfig);
});

registerChannel('msteams', (bus: MessageBus, config: ChannelConfig) => {
  return new MSTeamsChannel(bus, config as MSTeamsChannelConfig);
});

export { BaseChannel } from './base.js';
export type { ChannelConfig, SendOptions } from './base.js';
export {
  ChannelManager,
  registerChannel,
  createChannel,
  listRegisteredChannels,
} from './manager.js';
export { WebSocketChannel, WebSocketChannelConfig } from './websocket.js';
export { CliChannel } from './cli.js';
export { TelegramChannel, TelegramChannelConfig } from './telegram.js';
export { DiscordChannel, DiscordChannelConfig } from './discord.js';
export { SlackChannel, SlackChannelConfig } from './slack.js';
export { FeishuChannel, FeishuChannelConfig } from './feishu.js';
export { WeixinChannel, WeixinChannelConfig } from './weixin.js';
export { WecomChannel, WecomChannelConfig } from './wecom.js';
export { QQChannel, QQChannelConfig } from './qq.js';
export { DingTalkChannel, DingTalkChannelConfig } from './dingtalk.js';
export { EmailChannel, EmailChannelConfig } from './email.js';
export { WhatsAppChannel, WhatsAppChannelConfig } from './whatsapp.js';
export { SignalChannel, SignalChannelConfig } from './signal.js';
export { MatrixChannel, MatrixChannelConfig } from './matrix.js';
export { MattermostChannel, MattermostChannelConfig } from './mattermost.js';
export { MSTeamsChannel, MSTeamsChannelConfig } from './msteams.js';
