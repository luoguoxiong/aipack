import type { OutboundMessage } from './queue.js';

export class OutboundEvent {}

export interface ProgressEventOptions {
  content?: string;
  tool_hint?: boolean;
  reasoning?: boolean;
  reasoning_delta?: boolean;
  reasoning_end?: boolean;
  stream_id?: string;
  tool_events?: Record<string, unknown>[] | null;
  file_edit_events?: Record<string, unknown>[] | null;
}

export class ProgressEvent extends OutboundEvent {
  content: string;
  tool_hint: boolean;
  reasoning: boolean;
  reasoning_delta: boolean;
  reasoning_end: boolean;
  stream_id?: string;
  tool_events?: Record<string, unknown>[] | null;
  file_edit_events?: Record<string, unknown>[] | null;

  constructor(opts: ProgressEventOptions = {}) {
    super();
    this.content = opts.content ?? '';
    this.tool_hint = opts.tool_hint ?? false;
    this.reasoning = opts.reasoning ?? false;
    this.reasoning_delta = opts.reasoning_delta ?? false;
    this.reasoning_end = opts.reasoning_end ?? false;
    this.stream_id = opts.stream_id;
    this.tool_events = opts.tool_events;
    this.file_edit_events = opts.file_edit_events;
  }
}

export class RetryWaitEvent extends OutboundEvent {
  content: string;

  constructor(content = '') {
    super();
    this.content = content;
  }
}

export class StreamDeltaEvent extends OutboundEvent {
  content: string;
  stream_id?: string;

  constructor(opts: { content?: string; stream_id?: string } = {}) {
    super();
    this.content = opts.content ?? '';
    this.stream_id = opts.stream_id;
  }
}

export class StreamEndEvent extends OutboundEvent {
  content: string;
  stream_id?: string;
  resuming: boolean;

  constructor(opts: { content?: string; stream_id?: string; resuming?: boolean } = {}) {
    super();
    this.content = opts.content ?? '';
    this.stream_id = opts.stream_id;
    this.resuming = opts.resuming ?? false;
  }
}

export class StreamedResponseEvent extends OutboundEvent {}

export class TurnEndEvent extends OutboundEvent {
  latency_ms?: number;
  goal_state?: Record<string, unknown> | null;

  constructor(opts: { latency_ms?: number; goal_state?: Record<string, unknown> | null } = {}) {
    super();
    this.latency_ms = opts.latency_ms;
    this.goal_state = opts.goal_state;
  }
}

export class GoalStatusEvent extends OutboundEvent {
  status: string;
  started_at?: number | null;

  constructor(status: string, opts: { started_at?: number | null } = {}) {
    super();
    this.status = status;
    this.started_at = opts.started_at;
  }
}

export class GoalStateSyncEvent extends OutboundEvent {
  goal_state: Record<string, unknown>;

  constructor(goal_state: Record<string, unknown>) {
    super();
    this.goal_state = goal_state;
  }
}

export class SessionUpdatedEvent extends OutboundEvent {
  scope?: string | null;

  constructor(scope?: string | null) {
    super();
    this.scope = scope;
  }
}

export class RuntimeModelUpdatedEvent extends OutboundEvent {
  model?: string | null;
  model_preset?: string | null;

  constructor(opts: { model?: string | null; model_preset?: string | null } = {}) {
    super();
    this.model = opts.model;
    this.model_preset = opts.model_preset;
  }
}

export function outboundMessageForEvent(opts: {
  channel: string;
  chat_id: string;
  event: OutboundEvent;
  content?: string;
  metadata?: Record<string, unknown>;
}): OutboundMessage {
  const { channel, chat_id, event, metadata } = opts;
  const content = opts.content ?? eventContent(event);
  return {
    id: Math.random().toString(36).slice(2),
    channel,
    chat_id,
    text: content,
    media: [],
    metadata: { ...(metadata || {}), _event: event },
    timestamp: new Date().toISOString(),
  };
}

export function outboundEventFromMessage(msg: OutboundMessage): OutboundEvent | null {
  const meta = msg.metadata || {};
  if (meta['_event'] && meta['_event'] instanceof OutboundEvent) {
    return meta['_event'] as OutboundEvent;
  }
  return legacyEventFromMetadata(msg);
}

export function replaceOutboundEvent(
  msg: OutboundMessage,
  event: OutboundEvent,
  opts: { content?: string } = {},
): OutboundMessage {
  const content = opts.content ?? eventContent(event);
  return {
    ...msg,
    text: content,
    metadata: { ...(msg.metadata || {}), _event: event },
  };
}

function eventContent(event: OutboundEvent): string {
  if (
    event instanceof ProgressEvent ||
    event instanceof RetryWaitEvent ||
    event instanceof StreamDeltaEvent ||
    event instanceof StreamEndEvent
  ) {
    return event.content;
  }
  return '';
}

function legacyEventFromMetadata(msg: OutboundMessage): OutboundEvent | null {
  const meta = msg.metadata || {};
  if (meta['_runtime_model_updated']) {
    return new RuntimeModelUpdatedEvent({
      model: metadataStr(meta, 'model'),
      model_preset: metadataStr(meta, 'model_preset'),
    });
  }
  if (meta['_goal_state_sync']) {
    const goalState = meta['goal_state'];
    return new GoalStateSyncEvent(
      typeof goalState === 'object' && goalState !== null ? (goalState as Record<string, unknown>) : { active: false },
    );
  }
  if (meta['_goal_status']) {
    const status = meta['goal_status'];
    if (typeof status !== 'string' || !status) {
      return null;
    }
    return new GoalStatusEvent(status, {
      started_at: metadataFloat(meta, 'started_at', 'goal_started_at'),
    });
  }
  if (meta['_turn_end']) {
    const goalState = meta['goal_state'];
    return new TurnEndEvent({
      latency_ms: metadataInt(meta, 'latency_ms'),
      goal_state:
        typeof goalState === 'object' && goalState !== null ? (goalState as Record<string, unknown>) : undefined,
    });
  }
  if (meta['_session_updated']) {
    return new SessionUpdatedEvent(metadataStr(meta, '_session_update_scope'));
  }
  if (meta['_retry_wait']) {
    return new RetryWaitEvent(msg.text);
  }
  if (meta['_stream_end']) {
    return new StreamEndEvent({
      content: msg.text,
      stream_id: metadataStr(meta, '_stream_id'),
      resuming: Boolean(meta['_resuming']),
    });
  }
  if (meta['_stream_delta']) {
    return new StreamDeltaEvent({
      content: msg.text,
      stream_id: metadataStr(meta, '_stream_id'),
    });
  }
  if (meta['_streamed']) {
    return new StreamedResponseEvent();
  }
  if (
    meta['_progress'] ||
    meta['_reasoning_delta'] ||
    meta['_reasoning_end'] ||
    meta['_reasoning'] ||
    meta['_file_edit_events'] ||
    meta['_tool_events']
  ) {
    const toolEvents = meta['_tool_events'];
    const fileEditEvents = meta['_file_edit_events'];
    return new ProgressEvent({
      content: msg.text,
      tool_hint: Boolean(meta['_tool_hint']),
      reasoning: Boolean(meta['_reasoning']),
      reasoning_delta: Boolean(meta['_reasoning_delta']),
      reasoning_end: Boolean(meta['_reasoning_end']),
      stream_id: metadataStr(meta, '_stream_id'),
      tool_events: Array.isArray(toolEvents) ? toolEvents : null,
      file_edit_events: Array.isArray(fileEditEvents) ? fileEditEvents : null,
    });
  }
  return null;
}

function metadataStr(meta: Record<string, unknown>, key: string): string | undefined {
  const value = meta[key];
  return typeof value === 'string' && value ? value : undefined;
}

function metadataInt(meta: Record<string, unknown>, key: string): number | undefined {
  const value = meta[key];
  if (typeof value === 'boolean') {
    return undefined;
  }
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value;
  }
  return undefined;
}

function metadataFloat(meta: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = meta[key];
    if (typeof value === 'boolean') {
      continue;
    }
    if (typeof value === 'number') {
      return value;
    }
  }
  return undefined;
}
