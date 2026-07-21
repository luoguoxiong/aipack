import { EventEmitter } from 'events';
import { logger } from '../utils/logger.js';

export interface InboundMessage {
  id: string;
  channel: string;
  chat_id: string;
  sender_id: string;
  sender_name?: string;
  text: string;
  media?: string[];
  metadata?: Record<string, unknown>;
  timestamp: string;
  session_key?: string;
}

export interface OutboundMessage {
  id: string;
  channel: string;
  chat_id: string;
  text: string;
  media?: string[];
  metadata?: Record<string, unknown>;
  timestamp: string;
  reply_to?: string;
}

export interface StreamDeltaEvent {
  channel: string;
  chat_id: string;
  text_delta: string;
  metadata?: Record<string, unknown>;
}

export interface StreamEndEvent {
  channel: string;
  chat_id: string;
  final_text: string;
  metadata?: Record<string, unknown>;
}

export interface ToolCallEvent {
  channel: string;
  chat_id: string;
  tool_name: string;
  tool_call_id: string;
  arguments: unknown;
  status: 'started' | 'completed' | 'failed';
  result?: string;
  error?: string;
}

export type BusEvent =
  | { type: 'inbound_message'; payload: InboundMessage }
  | { type: 'outbound_message'; payload: OutboundMessage }
  | { type: 'stream_delta'; payload: StreamDeltaEvent }
  | { type: 'stream_end'; payload: StreamEndEvent }
  | { type: 'tool_call'; payload: ToolCallEvent };

type EventHandler<T = unknown> = (payload: T) => Promise<void> | void;

export class MessageBus {
  private emitter: EventEmitter;
  private handlers: Map<string, Set<EventHandler>> = new Map();

  constructor() {
    this.emitter = new EventEmitter();
    this.emitter.setMaxListeners(100);
  }

  publish(event: BusEvent): void {
    const handlers = this.handlers.get(event.type);
    if (handlers) {
      for (const handler of handlers) {
        Promise.resolve()
          .then(() => handler(event.payload))
          .catch(err => logger.error({ err, event_type: event.type }, 'Bus handler error'));
      }
    }
    this.emitter.emit(event.type, event.payload);
  }

  subscribe<T = unknown>(eventType: string, handler: EventHandler<T>): () => void {
    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, new Set());
    }
    this.handlers.get(eventType)!.add(handler as EventHandler);
    
    return () => {
      this.handlers.get(eventType)?.delete(handler as EventHandler);
    };
  }

  onInboundMessage(handler: (msg: InboundMessage) => Promise<void> | void): () => void {
    return this.subscribe('inbound_message', handler);
  }

  onOutboundMessage(handler: (msg: OutboundMessage) => Promise<void> | void): () => void {
    return this.subscribe('outbound_message', handler);
  }

  onStreamDelta(handler: (event: StreamDeltaEvent) => Promise<void> | void): () => void {
    return this.subscribe('stream_delta', handler);
  }

  onStreamEnd(handler: (event: StreamEndEvent) => Promise<void> | void): () => void {
    return this.subscribe('stream_end', handler);
  }

  onToolCall(handler: (event: ToolCallEvent) => Promise<void> | void): () => void {
    return this.subscribe('tool_call', handler);
  }
}

export function createMessageBus(): MessageBus {
  return new MessageBus();
}
