import { EventEmitter } from 'events';
import { logger } from '../utils/logger.js';
import type { InboundMessage } from './queue.js';

export interface RuntimeEventContext {
  channel: string;
  chat_id: string;
  session_key: string;
  metadata: Record<string, unknown>;
}

export class SessionTurnStarted {
  context: RuntimeEventContext;

  constructor(context: RuntimeEventContext) {
    this.context = context;
  }
}

export class TurnRunStatusChanged {
  context: RuntimeEventContext;
  status: string;
  started_at?: number | null;

  constructor(context: RuntimeEventContext, status: string, opts: { started_at?: number | null } = {}) {
    this.context = context;
    this.status = status;
    this.started_at = opts.started_at;
  }
}

export class TurnCompleted {
  context: RuntimeEventContext;
  latency_ms?: number;
  runtime?: unknown;

  constructor(
    context: RuntimeEventContext,
    opts: { latency_ms?: number; runtime?: unknown } = {},
  ) {
    this.context = context;
    this.latency_ms = opts.latency_ms;
    this.runtime = opts.runtime;
  }
}

export class GoalStateChanged {
  context: RuntimeEventContext;
  session_metadata: Record<string, unknown>;

  constructor(context: RuntimeEventContext, session_metadata: Record<string, unknown> = {}) {
    this.context = context;
    this.session_metadata = session_metadata;
  }
}

export class RuntimeModelChanged {
  model: string;
  model_preset?: string | null;

  constructor(model: string, model_preset?: string | null) {
    this.model = model;
    this.model_preset = model_preset;
  }
}

export type RuntimeEvent =
  | SessionTurnStarted
  | TurnRunStatusChanged
  | TurnCompleted
  | GoalStateChanged
  | RuntimeModelChanged;

export type RuntimeEventHandler = (event: RuntimeEvent) => Promise<void> | void;

type HandlerEntry = [new (...args: unknown[]) => RuntimeEvent] | null;

export type RuntimeEventConstructor = new (...args: unknown[]) => RuntimeEvent;

export class RuntimeEventBus {
  private handlers: Array<{
    eventType?: RuntimeEventConstructor;
    handler: RuntimeEventHandler;
  }> = [];
  private emitter = new EventEmitter();

  subscribe(handler: RuntimeEventHandler, eventType?: RuntimeEventConstructor): () => void {
    const entry = { eventType, handler };
    this.handlers.push(entry);

    return () => {
      const idx = this.handlers.indexOf(entry);
      if (idx !== -1) {
        this.handlers.splice(idx, 1);
      }
    };
  }

  async publish(event: RuntimeEvent): Promise<void> {
    for (const entry of [...this.handlers]) {
      if (entry.eventType && !(event instanceof entry.eventType)) {
        continue;
      }
      try {
        const result = entry.handler(event);
        if (result && typeof (result as Promise<void>).then === 'function') {
          await result;
        }
      } catch (err) {
        logger.error({ err, event_type: event.constructor.name }, 'Runtime event handler error');
      }
    }
  }

  publishNowait(event: RuntimeEvent): void {
    setImmediate(() => {
      this.publish(event).catch(err => {
        logger.error({ err }, 'Failed to publish runtime event');
      });
    });
  }
}

export class RuntimeEventPublisher {
  bus: RuntimeEventBus;
  private turnLatencyMs: Map<string, number> = new Map();
  private turnRuntime: Map<string, unknown> = new Map();

  constructor(bus?: RuntimeEventBus) {
    this.bus = bus || new RuntimeEventBus();
  }

  private static context(opts: {
    channel: string;
    chat_id: string;
    session_key: string;
    metadata?: Record<string, unknown> | null;
  }): RuntimeEventContext {
    return {
      channel: opts.channel,
      chat_id: opts.chat_id,
      session_key: opts.session_key,
      metadata: { ...(opts.metadata || {}) },
    };
  }

  recordTurnRuntime(sessionKey: string, runtime: unknown): void {
    this.turnRuntime.set(sessionKey, runtime);
  }

  recordTurnLatency(sessionKey: string, latencyMs: number | null | undefined): void {
    if (latencyMs !== null && latencyMs !== undefined) {
      this.turnLatencyMs.set(sessionKey, Math.floor(latencyMs));
    }
  }

  clearTurn(sessionKey: string): void {
    this.turnLatencyMs.delete(sessionKey);
    this.turnRuntime.delete(sessionKey);
  }

  async sessionTurnStarted(msg: InboundMessage, sessionKey: string): Promise<void> {
    await this.bus.publish(
      new SessionTurnStarted(
        RuntimeEventPublisher.context({
          channel: msg.channel,
          chat_id: msg.chat_id,
          session_key: sessionKey,
          metadata: msg.metadata,
        }),
      ),
    );
  }

  async runStatusChanged(
    msg: InboundMessage,
    sessionKey: string,
    status: string,
    opts: { started_at?: number | null } = {},
  ): Promise<void> {
    await this.bus.publish(
      new TurnRunStatusChanged(
        RuntimeEventPublisher.context({
          channel: msg.channel,
          chat_id: msg.chat_id,
          session_key: sessionKey,
          metadata: msg.metadata,
        }),
        status,
        { started_at: opts.started_at },
      ),
    );
  }

  async turnCompleted(opts: {
    channel: string;
    chat_id: string;
    session_key: string;
    metadata?: Record<string, unknown> | null;
  }): Promise<void> {
    const sessionKey = opts.session_key;
    await this.bus.publish(
      new TurnCompleted(
        RuntimeEventPublisher.context({
          channel: opts.channel,
          chat_id: opts.chat_id,
          session_key: sessionKey,
          metadata: opts.metadata,
        }),
        {
          latency_ms: this.turnLatencyMs.get(sessionKey),
          runtime: this.turnRuntime.get(sessionKey),
        },
      ),
    );
    this.turnLatencyMs.delete(sessionKey);
    this.turnRuntime.delete(sessionKey);
  }

  runtimeModelChanged(model: string, modelPreset?: string | null): void {
    this.bus.publishNowait(new RuntimeModelChanged(model, modelPreset));
  }
}

export function ensureRuntimeEventPublisher(owner: Record<string, unknown>): RuntimeEventPublisher {
  const publisher = owner['runtime_event_publisher'];
  if (publisher instanceof RuntimeEventPublisher) {
    return publisher;
  }

  let bus = owner['runtime_events'];
  if (!(bus instanceof RuntimeEventBus)) {
    bus = new RuntimeEventBus();
    owner['runtime_events'] = bus;
  }

  const newPublisher = new RuntimeEventPublisher(bus as RuntimeEventBus);
  owner['runtime_event_publisher'] = newPublisher;
  return newPublisher;
}
