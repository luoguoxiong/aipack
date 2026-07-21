import type { InboundMessage, OutboundMessage } from './queue.js';

export const OUTBOUND_META_AGENT_UI = '_agent_ui';

export const INBOUND_META_RUNTIME_CONTROL = '_runtime_control';
export const RUNTIME_CONTROL_ACK = '_ack';
export const RUNTIME_CONTROL_MCP_RELOAD = 'mcp_reload';

export function sessionKey(msg: { channel: string; chat_id: string; session_key?: string }): string {
  return msg.session_key || `${msg.channel}:${msg.chat_id}`;
}

export function createInboundMessage(
  opts: Partial<InboundMessage> & { channel: string; sender_id: string; chat_id: string; text: string },
): InboundMessage {
  return {
    id: opts.id || Math.random().toString(36).slice(2),
    timestamp: new Date().toISOString(),
    media: [],
    metadata: {},
    ...opts,
  };
}

export function createOutboundMessage(
  opts: Partial<OutboundMessage> & { channel: string; chat_id: string; text: string },
): OutboundMessage {
  return {
    id: opts.id || Math.random().toString(36).slice(2),
    timestamp: new Date().toISOString(),
    media: [],
    metadata: {},
    ...opts,
  };
}
