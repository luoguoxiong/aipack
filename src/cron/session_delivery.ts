import { logger } from '../utils/logger.js';
import { cronDeliveryContextFromMetadata, cronDeliveryMetadata } from './webui_metadata.js';
import { cronTurnMetadataForJob } from './session_turns.js';
import type { InboundMessage } from '../bus/queue.js';
import type { SessionManager } from '../session/manager.js';

export async function cronDeliverMessageToSession(opts: {
  msg: InboundMessage;
  sessions: SessionManager;
}): Promise<boolean> {
  const ctx = cronDeliveryContextFromMetadata(opts.msg.metadata);
  if (!ctx) {
    return false;
  }

  logger.debug({ cron_id: ctx.cron_id }, 'delivering cron-triggered message to session');

  const session = await opts.sessions.getSession(ctx.session_key);
  const meta = cronTurnMetadataForJob({
    id: ctx.cron_id,
    name: ctx.cron_name,
    triggered_at: new Date().toISOString(),
  });

  await opts.sessions.addMessage(ctx.session_key, {
    role: 'user',
    content: opts.msg.text,
    metadata: {
      ...(opts.msg.metadata || {}),
      ...meta,
    },
  });

  return true;
}

export async function cronDeliverResultMessage(opts: {
  msg: InboundMessage;
  sessions: SessionManager;
}): Promise<boolean> {
  const ctx = cronDeliveryContextFromMetadata(opts.msg.metadata);
  if (!ctx) {
    return false;
  }

  logger.debug({ cron_id: ctx.cron_id }, 'delivering cron result message');

  await opts.sessions.addMessage(ctx.session_key, {
    role: 'assistant',
    content: opts.msg.text,
    metadata: {
      ...(opts.msg.metadata || {}),
      _streamed: true,
    },
  });

  return true;
}

export function isCronDeliveredMessage(msg: InboundMessage): boolean {
  return cronDeliveryContextFromMetadata(msg.metadata) !== null;
}

export function prepareCronDeliveryMessage(opts: {
  chatId: string;
  channel: string;
  sessionKey: string;
  cronId: string;
  cronName: string;
  text: string;
}): InboundMessage {
  const metadata = cronDeliveryMetadata({
    chat_id: opts.chatId,
    channel: opts.channel,
    session_key: opts.sessionKey,
    cron_id: opts.cronId,
    cron_name: opts.cronName,
  });

  return {
    id: `cron_${opts.cronId}_${Date.now()}`,
    channel: opts.channel,
    chat_id: opts.chatId,
    sender_id: 'cron',
    text: opts.text,
    timestamp: new Date().toISOString(),
    metadata,
    session_key: opts.sessionKey,
  };
}