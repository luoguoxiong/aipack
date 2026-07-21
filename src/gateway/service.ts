import { logger } from '../utils/logger.js';
import type { InboundMessage, OutboundMessage } from '../bus/queue.js';

export type ChannelHandler = (msg: InboundMessage) => Promise<OutboundMessage | null>;

export class GatewayService {
  private _channels: Map<string, ChannelHandler> = new Map();
  private _outboundHandlers: Array<(msg: OutboundMessage) => Promise<void>> = [];

  registerChannel(name: string, handler: ChannelHandler): void {
    this._channels.set(name, handler);
    logger.info({ channel: name }, 'Gateway channel registered');
  }

  unregisterChannel(name: string): boolean {
    return this._channels.delete(name);
  }

  async handleInbound(msg: InboundMessage): Promise<OutboundMessage | null> {
    const handler = this._channels.get(msg.channel);
    if (!handler) {
      logger.warn({ channel: msg.channel }, 'No handler registered for channel');
      return null;
    }
    try {
      const result = await handler(msg);
      if (result) {
        await this._publishOutbound(result);
      }
      return result;
    } catch (err) {
      logger.error({ err, channel: msg.channel }, 'Error handling inbound message');
      return null;
    }
  }

  onOutbound(handler: (msg: OutboundMessage) => Promise<void>): void {
    this._outboundHandlers.push(handler);
  }

  private async _publishOutbound(msg: OutboundMessage): Promise<void> {
    for (const handler of this._outboundHandlers) {
      try {
        await handler(msg);
      } catch (err) {
        logger.error({ err }, 'Error in outbound handler');
      }
    }
  }
}
