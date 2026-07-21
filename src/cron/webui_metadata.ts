import { CRON_TRIGGER_META_KEY } from './session_turns.js';

export const CRON_DELIVERY_META_KEY = '_cron_delivery';

export interface CronDeliveryContext {
  chat_id: string;
  channel: string;
  session_key: string;
  cron_id: string;
  cron_name: string;
}

export function cronDeliveryContextFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
): CronDeliveryContext | null {
  const raw = metadata?.[CRON_DELIVERY_META_KEY];
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const ctx = raw as Record<string, unknown>;
  const chatId = String(ctx['chat_id'] || '').trim();
  const channel = String(ctx['channel'] || '').trim();
  const sessionKey = String(ctx['session_key'] || '').trim();
  const cronId = String(ctx['cron_id'] || '').trim();

  if (!chatId || !channel || !sessionKey || !cronId) {
    return null;
  }

  return {
    chat_id: chatId,
    channel,
    session_key: sessionKey,
    cron_id: cronId,
    cron_name: String(ctx['cron_name'] || '').trim(),
  };
}

export function cronDeliveryMetadata(ctx: CronDeliveryContext): Record<string, unknown> {
  return {
    [CRON_DELIVERY_META_KEY]: {
      chat_id: ctx.chat_id,
      channel: ctx.channel,
      session_key: ctx.session_key,
      cron_id: ctx.cron_id,
      cron_name: ctx.cron_name,
    },
    [CRON_TRIGGER_META_KEY]: {
      id: ctx.cron_id,
      name: ctx.cron_name,
      triggered_at: new Date().toISOString(),
    },
  };
}