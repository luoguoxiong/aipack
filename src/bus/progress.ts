import type { MessageBus, InboundMessage } from './queue.js';
import { ProgressEvent, outboundMessageForEvent } from './outbound_events.js';

export type ProgressCallback = (
  content: string,
  opts?: {
    tool_hint?: boolean;
    tool_events?: Record<string, unknown>[] | null;
    file_edit_events?: Record<string, unknown>[] | null;
    reasoning?: boolean;
    reasoning_end?: boolean;
  },
) => Promise<void>;

export function buildBusProgressCallback(bus: MessageBus, msg: InboundMessage): ProgressCallback {
  const publishProgress = async (
    content: string,
    opts: {
      tool_hint?: boolean;
      tool_events?: Record<string, unknown>[] | null;
      file_edit_events?: Record<string, unknown>[] | null;
      reasoning?: boolean;
      reasoning_end?: boolean;
    } = {},
  ) => {
    const event = new ProgressEvent({
      content,
      tool_hint: opts.tool_hint,
      reasoning_delta: opts.reasoning,
      reasoning_end: opts.reasoning_end,
      tool_events: opts.tool_events,
      file_edit_events: opts.file_edit_events,
    });
    const outbound = outboundMessageForEvent({
      channel: msg.channel,
      chat_id: msg.chat_id,
      event,
      metadata: msg.metadata,
    });
    bus.publish({ type: 'outbound_message', payload: outbound });
  };

  return publishProgress;
}
