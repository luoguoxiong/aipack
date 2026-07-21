import {
  STREAM_EVENT_REASONING_COMPLETED,
  STREAM_EVENT_REASONING_DELTA,
  STREAM_EVENT_TEXT_COMPLETED,
  STREAM_EVENT_TEXT_DELTA,
  STREAM_EVENT_TOOL_COMPLETED,
  STREAM_EVENT_TOOL_FAILED,
  STREAM_EVENT_TOOL_STARTED,
  RunResult,
  StreamEvent,
  StreamEventType,
} from './types.js';

const _STREAM_SENTINEL = Symbol("stream-sentinel");
type QueueItem = StreamEvent | typeof _STREAM_SENTINEL;

export class RunStream {
  private _eventsStarted = false;
  private _eventsDone = false;
  private _streamActive = false;
  private _closed = false;

  constructor(
    private _task: Promise<RunResult>,
    private _queue: Array<QueueItem>,
  ) {}

  get done(): boolean {
    return this._eventsDone;
  }

  async *streamEvents(): AsyncGenerator<StreamEvent> {
    if (this._eventsStarted) {
      throw new Error("RunStream.streamEvents() can only be consumed once");
    }
    this._eventsStarted = true;
    this._streamActive = true;
    try {
      while (true) {
        while (this._queue.length === 0) {
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        const item = this._queue.shift()!;
        if (item === _STREAM_SENTINEL) {
          this._eventsDone = true;
          break;
        }
        yield item;
      }
    } finally {
      this._streamActive = false;
      if (!this._eventsDone) {
        await this.close();
      }
    }
  }

  async wait(): Promise<RunResult> {
    if (!this._eventsDone && !this._streamActive) {
      if (!this._eventsStarted) {
        this._eventsStarted = true;
      }
      await this._drainEvents();
    }
    return this._task;
  }

  async text(): Promise<string> {
    return (await this.wait()).content;
  }

  async cancel(): Promise<void> {
    await this.close();
  }

  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    this._finishEvents();
    try {
      await this._task;
    } catch {
      // ignore
    }
  }

  private async _drainEvents(): Promise<void> {
    while (!this._eventsDone) {
      while (this._queue.length === 0) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      const item = this._queue.shift()!;
      if (item === _STREAM_SENTINEL) {
        this._eventsDone = true;
        break;
      }
    }
  }

  private _finishEvents(): void {
    this._eventsDone = true;
    this._queue = [];
    this._queue.push(_STREAM_SENTINEL);
  }
}

export class SDKStreamEmitter {
  private _textParts: string[] = [];
  private _closed = false;

  constructor(private _queue: Array<QueueItem>) {}

  async emit(event: StreamEvent): Promise<void> {
    if (this._closed) return;
    this._queue.push(event);
  }

  async textDelta(delta: string, options?: { iteration?: number }): Promise<void> {
    if (!delta) return;
    this._textParts.push(delta);
    await this.emit({
      type: STREAM_EVENT_TEXT_DELTA,
      delta,
      content: "",
      result: null,
      name: null,
      tool_call_id: null,
      arguments: null,
      iteration: options?.iteration ?? null,
      resuming: null,
      usage: {},
      error: null,
      metadata: {},
    });
  }

  async textCompleted(options?: { resuming?: boolean; iteration?: number; force?: boolean }): Promise<void> {
    const content = this._textParts.join("");
    const { resuming = false, force = true } = options || {};
    if (!content && (resuming || !force)) return;
    this._textParts = [];
    await this.emit({
      type: STREAM_EVENT_TEXT_COMPLETED,
      delta: "",
      content,
      result: null,
      name: null,
      tool_call_id: null,
      arguments: null,
      iteration: options?.iteration ?? null,
      resuming: resuming ?? null,
      usage: {},
      error: null,
      metadata: {},
    });
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;
    this._queue.push(_STREAM_SENTINEL);
  }
}

export class SDKStreamingHook {
  private _reasoningOpen = false;

  constructor(private _emitter: SDKStreamEmitter) {}

  async beforeExecuteTools(context: { tool_calls: Array<{ name: string; id: string; arguments: Record<string, unknown> }>; iteration?: number }): Promise<void> {
    for (const call of context.tool_calls) {
      await this._emitter.emit({
        type: STREAM_EVENT_TOOL_STARTED,
        delta: "",
        content: "",
        result: null,
        name: call.name,
        tool_call_id: call.id,
        arguments: { ...call.arguments },
        iteration: context.iteration ?? null,
        resuming: null,
        usage: {},
        error: null,
        metadata: {},
      });
    }
  }

  async emitReasoning(reasoningContent: string | null): Promise<void> {
    if (!reasoningContent) return;
    this._reasoningOpen = true;
    await this._emitter.emit({
      type: STREAM_EVENT_REASONING_DELTA,
      delta: reasoningContent,
      content: "",
      result: null,
      name: null,
      tool_call_id: null,
      arguments: null,
      iteration: null,
      resuming: null,
      usage: {},
      error: null,
      metadata: {},
    });
  }

  async emitReasoningEnd(): Promise<void> {
    if (!this._reasoningOpen) return;
    this._reasoningOpen = false;
    await this._emitter.emit({
      type: STREAM_EVENT_REASONING_COMPLETED,
      delta: "",
      content: "",
      result: null,
      name: null,
      tool_call_id: null,
      arguments: null,
      iteration: null,
      resuming: null,
      usage: {},
      error: null,
      metadata: {},
    });
  }

  async afterIteration(context: { tool_events: Record<string, unknown>[]; tool_calls: Array<{ name: string; id: string; arguments: Record<string, unknown> }>; iteration?: number }): Promise<void> {
    if (!context.tool_events.length) return;
    for (let index = 0; index < context.tool_events.length; index++) {
      const rawEvent = context.tool_events[index];
      const call = context.tool_calls[index];
      const event = { ...rawEvent };
      const status = event.status as string;
      const name = String(event.name || (call?.name || ""));
      const eventType: StreamEventType = status === "ok" ? STREAM_EVENT_TOOL_COMPLETED : STREAM_EVENT_TOOL_FAILED;
      await this._emitter.emit({
        type: eventType,
        delta: "",
        content: "",
        result: null,
        name: name || null,
        tool_call_id: call?.id || null,
        arguments: call ? { ...call.arguments } : null,
        iteration: context.iteration ?? null,
        resuming: null,
        usage: {},
        error: status === "ok" ? null : String(event.detail || ""),
        metadata: event,
      });
    }
  }
}