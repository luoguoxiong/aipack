import crypto from 'crypto';
import { logger } from '../utils/logger.js';
import { LLMRuntime } from '../utils/llm_runtime.js';
import { LLMProvider } from '../providers/base.js';
import { publicHistoryMessage } from '../runtime_context.js';
import { goalStateWsBlob } from './goal_state.js';
import type { Session, SessionManager } from './manager.js';
import type { InboundMessage } from '../bus/queue.js';
import { outboundMessageForEvent } from '../bus/outbound_events.js';
import {
  GoalStateSyncEvent,
  GoalStatusEvent,
  RuntimeModelUpdatedEvent,
  SessionUpdatedEvent,
  TurnEndEvent,
} from '../bus/outbound_events.js';
import type { MessageBus } from '../bus/queue.js';
import type { RuntimeEventBus, RuntimeEventContext, RuntimeEventHandler, RuntimeEventConstructor } from '../bus/runtime_events.js';
import {
  GoalStateChanged,
  RuntimeModelChanged,
  SessionTurnStarted,
  TurnCompleted,
  TurnRunStatusChanged,
} from '../bus/runtime_events.js';

export const WEBUI_SESSION_METADATA_KEY = 'webui';
export const WEBUI_TITLE_METADATA_KEY = 'title';
export const WEBUI_TITLE_USER_EDITED_METADATA_KEY = 'title_user_edited';
export const TITLE_MAX_CHARS = 60;
export const TITLE_GENERATION_MAX_TOKENS = 96;
export const TITLE_GENERATION_REASONING_EFFORT = 'none';

const _WEBSOCKET_TURN_WALL_STARTED_AT = new Map<string, number>();

export function markWebuiSession(session: Session, metadata: Record<string, unknown>): boolean {
  if (metadata[WEBUI_SESSION_METADATA_KEY] !== true) {
    return false;
  }
  session.metadata[WEBUI_SESSION_METADATA_KEY] = true;
  return true;
}

export function cleanGeneratedTitle(raw: string | null | undefined): string {
  let text = (raw || '').trim();
  if (!text) {
    return '';
  }
  text = text.replace(/^\s*(title|标题)\s*[:：]\s*/i, '');
  text = text.trim().replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, '');
  text = text.replace(/\s+/g, ' ').trim();
  text = text.replace(/[。.!！?？,，;；:]+$/, '');
  if (text.length > TITLE_MAX_CHARS) {
    text = text.slice(0, TITLE_MAX_CHARS - 1).trimEnd() + '…';
  }
  return text;
}

function _titleInputs(session: Session): [string, string] {
  let userText = '';
  let assistantText = '';
  for (const message of session.messages) {
    if (message.metadata?.['_command'] === true) {
      continue;
    }
    const cleaned = publicHistoryMessage(message as unknown as Record<string, unknown>);
    const role = cleaned.role as string;
    const content = cleaned.content;
    if (typeof content !== 'string' || !content.trim()) {
      continue;
    }
    if (role === 'user' && !userText) {
      userText = content.trim();
    } else if (role === 'assistant' && !assistantText) {
      assistantText = content.trim();
    }
    if (userText && assistantText) {
      break;
    }
  }
  return [userText, assistantText];
}

export async function maybeGenerateWebuiTitle(opts: {
  sessions: SessionManager;
  sessionKey: string;
  provider: LLMProvider;
  model: string;
}): Promise<boolean> {
  const session = await opts.sessions.getSession(opts.sessionKey);
  if (session.metadata[WEBUI_SESSION_METADATA_KEY] !== true) {
    return false;
  }
  if (session.metadata[WEBUI_TITLE_USER_EDITED_METADATA_KEY] === true) {
    return false;
  }
  const currentTitle = session.metadata[WEBUI_TITLE_METADATA_KEY] as string | undefined;
  if (typeof currentTitle === 'string' && currentTitle.trim()) {
    const cleaned = cleanGeneratedTitle(currentTitle);
    if (cleaned) {
      if (cleaned !== currentTitle) {
        session.metadata[WEBUI_TITLE_METADATA_KEY] = cleaned;
        await opts.sessions.replaceMessages(opts.sessionKey, session.messages);
      }
      return false;
    }
    delete session.metadata[WEBUI_TITLE_METADATA_KEY];
  }

  const [userText, assistantText] = _titleInputs(session);
  if (!userText) {
    return false;
  }

  const truncateText = (text: string, max: number) => (text.length > max ? text.slice(0, max) + '…' : text);

  let prompt = (
    'Generate a concise title for this chat.\n' +
    'Rules:\n' +
    '- Use the same language as the user when practical.\n' +
    '- 3 to 8 words.\n' +
    '- No quotes.\n' +
    '- No punctuation at the end.\n' +
    '- Return only the title.\n\n' +
    `User: ${truncateText(userText, 1000)}`
  );

  if (assistantText) {
    prompt += `\nAssistant: ${truncateText(assistantText, 1000)}`;
  }

  try {
    const response = await opts.provider.complete(
      [
        {
          role: 'system',
          content: 'You write short, neutral chat titles. Return only the title text.',
        },
        { role: 'user', content: prompt },
      ],
      [],
      {
        model: opts.model,
        provider: opts.provider.name,
        max_tokens: TITLE_GENERATION_MAX_TOKENS,
        context_window_tokens: 2048,
        temperature: 0.2,
        reasoning_effort: TITLE_GENERATION_REASONING_EFFORT,
      },
    );

    const title = cleanGeneratedTitle(response.content);
    if (!title || title.toLowerCase().startsWith('error')) {
      logger.debug(
        { session_key: opts.sessionKey, finish_reason: response.stop_reason },
        'WebUI title generation returned no usable title',
      );
      return false;
    }

    session.metadata[WEBUI_TITLE_METADATA_KEY] = title;
    await opts.sessions.replaceMessages(opts.sessionKey, session.messages);
    return true;
  } catch (err) {
    logger.debug({ err, session_key: opts.sessionKey }, 'Failed to generate webui session title');
    return false;
  }
}

export async function maybeGenerateWebuiTitleAfterTurn(opts: {
  channel: string;
  metadata: Record<string, unknown>;
  sessions: SessionManager;
  sessionKey: string;
  provider: LLMProvider;
  model: string;
}): Promise<boolean> {
  if (opts.channel !== 'websocket' || opts.metadata[WEBUI_SESSION_METADATA_KEY] !== true) {
    return false;
  }
  return await maybeGenerateWebuiTitle({
    sessions: opts.sessions,
    sessionKey: opts.sessionKey,
    provider: opts.provider,
    model: opts.model,
  });
}

export function websocketTurnWallStartedAt(chatId: string): number | null {
  return _WEBSOCKET_TURN_WALL_STARTED_AT.get(chatId) ?? null;
}

export async function publishTurnRunStatus(opts: {
  bus: MessageBus;
  msg: InboundMessage;
  status: string;
  startedAt?: number | null;
}): Promise<void> {
  if (opts.msg.channel !== 'websocket') {
    return;
  }
  const cid = String(opts.msg.chat_id);
  let startedAtEvent: number | null = null;
  if (opts.status === 'running') {
    const t0 = typeof opts.startedAt === 'number' && opts.startedAt > 0 ? opts.startedAt : Date.now() / 1000;
    startedAtEvent = t0;
    _WEBSOCKET_TURN_WALL_STARTED_AT.set(cid, t0);
  } else {
    _WEBSOCKET_TURN_WALL_STARTED_AT.delete(cid);
  }
  await publishOutboundMessage(opts.bus, {
    channel: opts.msg.channel,
    chat_id: cid,
    event: new GoalStatusEvent(opts.status, { started_at: startedAtEvent }),
    metadata: opts.msg.metadata,
  });
}

async function publishOutboundMessage(
  bus: MessageBus,
  opts: {
    channel: string;
    chat_id: string;
    event: unknown;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  const msg = outboundMessageForEvent({
    channel: opts.channel,
    chat_id: opts.chat_id,
    event: opts.event as any,
    metadata: opts.metadata,
  });
  bus.publish({ type: 'outbound_message', payload: msg });
}

export class WebuiTurnCoordinator {
  private bus: MessageBus;
  private sessions: SessionManager;
  private scheduleBackground: (task: Promise<void>) => void;
  private _titleContexts = new Map<string, LLMRuntime>();

  constructor(opts: {
    bus: MessageBus;
    sessions: SessionManager;
    scheduleBackground: (task: Promise<void>) => void;
  }) {
    this.bus = opts.bus;
    this.sessions = opts.sessions;
    this.scheduleBackground = opts.scheduleBackground;
  }

  subscribe(runtimeEvents: RuntimeEventBus): () => void {
    const unsubscribe = [
      runtimeEvents.subscribe(
        this._handleSessionTurnStarted.bind(this) as RuntimeEventHandler,
        SessionTurnStarted as RuntimeEventConstructor,
      ),
      runtimeEvents.subscribe(
        this._handleRunStatusChanged.bind(this) as RuntimeEventHandler,
        TurnRunStatusChanged as RuntimeEventConstructor,
      ),
      runtimeEvents.subscribe(
        this._handleTurnCompletedEvent.bind(this) as RuntimeEventHandler,
        TurnCompleted as RuntimeEventConstructor,
      ),
      runtimeEvents.subscribe(
        this._handleGoalStateChanged.bind(this) as RuntimeEventHandler,
        GoalStateChanged as RuntimeEventConstructor,
      ),
      runtimeEvents.subscribe(
        this._handleRuntimeModelChanged.bind(this) as RuntimeEventHandler,
        RuntimeModelChanged as RuntimeEventConstructor,
      ),
    ];

    return () => {
      for (const fn of unsubscribe.reverse()) {
        fn();
      }
    };
  }

  private _ctxMsg(ctx: RuntimeEventContext): InboundMessage {
    return {
      id: crypto.randomUUID(),
      channel: ctx.channel,
      sender_id: 'runtime',
      chat_id: ctx.chat_id,
      text: '',
      timestamp: new Date().toISOString(),
      metadata: { ...(ctx.metadata || {}) },
      session_key: ctx.session_key,
    };
  }

  private _isWebsocketEvent(ctx: RuntimeEventContext): boolean {
    return ctx.channel === 'websocket';
  }

  private _handleSessionTurnStarted(event: SessionTurnStarted): void {
    if (!this._isWebsocketEvent(event.context)) {
      return;
    }
    this.sessions.getSession(event.context.session_key).then(session => {
      markWebuiSession(session, event.context.metadata);
    }).catch(err => {
      logger.debug({ err }, 'Failed to mark webui session');
    });
  }

  private async _handleRunStatusChanged(event: TurnRunStatusChanged): Promise<void> {
    if (!this._isWebsocketEvent(event.context)) {
      return;
    }
    await publishTurnRunStatus({
      bus: this.bus,
      msg: this._ctxMsg(event.context),
      status: event.status,
      startedAt: event.started_at,
    });
  }

  private async _handleTurnCompletedEvent(event: TurnCompleted): Promise<void> {
    if (!this._isWebsocketEvent(event.context)) {
      return;
    }
    const msg = this._ctxMsg(event.context);
    await this.handleTurnEnd({
      msg,
      sessionKey: event.context.session_key,
      latencyMs: event.latency_ms,
    });
    this._scheduleTitleUpdateFromEvent(event);
  }

  private async _handleGoalStateChanged(event: GoalStateChanged): Promise<void> {
    if (!this._isWebsocketEvent(event.context)) {
      return;
    }
    const cid = String(event.context.chat_id || '').trim();
    if (!cid) {
      return;
    }
    await publishOutboundMessage(this.bus, {
      channel: event.context.channel,
      chat_id: cid,
      event: new GoalStateSyncEvent(goalStateWsBlob(event.session_metadata)),
      metadata: event.context.metadata,
    });
  }

  private async _handleRuntimeModelChanged(event: RuntimeModelChanged): Promise<void> {
    await publishOutboundMessage(this.bus, {
      channel: 'websocket',
      chat_id: '*',
      event: new RuntimeModelUpdatedEvent({
        model: event.model,
        model_preset: event.model_preset,
      }),
    });
  }

  captureTitleContext(sessionKey: string, msg: InboundMessage, llm: LLMRuntime): void {
    if (msg.channel === 'websocket' && msg.metadata?.['webui'] === true) {
      this._titleContexts.set(sessionKey, llm);
    }
  }

  discard(sessionKey: string): void {
    this._titleContexts.delete(sessionKey);
  }

  async publishRunStatus(opts: {
    msg: InboundMessage;
    status: string;
    startedAt?: number | null;
  }): Promise<void> {
    await publishTurnRunStatus({
      bus: this.bus,
      msg: opts.msg,
      status: opts.status,
      startedAt: opts.startedAt,
    });
  }

  async handleTurnEnd(opts: {
    msg: InboundMessage;
    sessionKey: string;
    latencyMs?: number | null;
  }): Promise<void> {
    if (opts.msg.channel !== 'websocket') {
      return;
    }

    const session = await this.sessions.getSession(opts.sessionKey);
    await publishOutboundMessage(this.bus, {
      channel: opts.msg.channel,
      chat_id: opts.msg.chat_id,
      event: new TurnEndEvent({
        latency_ms: opts.latencyMs ?? undefined,
        goal_state: goalStateWsBlob(session.metadata),
      }),
      metadata: opts.msg.metadata,
    });
    this._scheduleTitleUpdate(opts.msg, { sessionKey: opts.sessionKey });
  }

  private _scheduleTitleUpdate(msg: InboundMessage, opts: { sessionKey: string }): void {
    const titleContext = this._titleContexts.get(opts.sessionKey);
    if (msg.metadata?.['webui'] !== true || !titleContext) {
      return;
    }

    const task = (async () => {
      const generated = await maybeGenerateWebuiTitleAfterTurn({
        channel: msg.channel,
        metadata: msg.metadata || {},
        sessions: this.sessions,
        sessionKey: opts.sessionKey,
        provider: titleContext.provider,
        model: titleContext.model,
      });
      if (generated) {
        await this._publishSessionMetadataUpdated({
          channel: msg.channel,
          chatId: msg.chat_id,
          metadata: msg.metadata,
        });
      }
    })();

    this.scheduleBackground(task);
  }

  private _scheduleTitleUpdateFromEvent(event: TurnCompleted): void {
    const titleContext = event.runtime as LLMRuntime | null | undefined;
    if (
      event.context.metadata['webui'] !== true ||
      !(titleContext instanceof LLMRuntime)
    ) {
      return;
    }

    const task = (async () => {
      const generated = await maybeGenerateWebuiTitleAfterTurn({
        channel: event.context.channel,
        metadata: event.context.metadata,
        sessions: this.sessions,
        sessionKey: event.context.session_key,
        provider: titleContext.provider,
        model: titleContext.model,
      });
      if (generated) {
        await this._publishSessionMetadataUpdated({
          channel: event.context.channel,
          chatId: event.context.chat_id,
          metadata: event.context.metadata,
        });
      }
    })();

    this.scheduleBackground(task);
  }

  private async _publishSessionMetadataUpdated(opts: {
    channel: string;
    chatId: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    await publishOutboundMessage(this.bus, {
      channel: opts.channel,
      chat_id: opts.chatId,
      event: new SessionUpdatedEvent('metadata'),
      metadata: opts.metadata,
    });
  }
}