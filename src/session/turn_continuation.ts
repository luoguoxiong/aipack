import { logger } from '../utils/logger.js';
import {
  goalStateRuntimeLines,
  sustainedGoalActive,
  sustainedGoalTurn,
} from './goal_state.js';

export const INTERNAL_CONTINUATION_META = '_internal_continuation';
export const INTERNAL_CONTINUATION_KIND_META = '_internal_continuation_kind';
export const INTERNAL_CONTINUATION_PENDING_META = '_internal_continuation_pending';
export const INTERNAL_CONTINUATION_RUN_STARTED_AT_META = '_internal_continuation_run_started_at';
export const SKIP_USER_PERSIST_META = '_skip_user_persist';

const _GOAL_CONTINUATION_KIND = 'sustained_goal';
const _GOAL_CONTINUATION_SENDER = 'system:continuation';
const _GOAL_CONTINUATION_ROUNDS_KEY = '_sustained_goal_continuation_rounds';
const _MAX_GOAL_CONTINUATION_ROUNDS = 12;
const _STRIPPED_INBOUND_META_KEYS = new Set([
  INTERNAL_CONTINUATION_PENDING_META,
  'goal_requested',
  'original_command',
]);

export function internalContinuationInbound(
  metadata: Record<string, unknown> | null | undefined,
): boolean {
  return Boolean(metadata && metadata[INTERNAL_CONTINUATION_META] === true);
}

export function internalContinuationPending(
  metadata: Record<string, unknown> | null | undefined,
): boolean {
  return Boolean(metadata && metadata[INTERNAL_CONTINUATION_PENDING_META] === true);
}

export function internalContinuationRunStartedAt(
  metadata: Record<string, unknown> | null | undefined,
): number | null {
  if (!metadata) {
    return null;
  }
  const value = metadata[INTERNAL_CONTINUATION_RUN_STARTED_AT_META];
  if (typeof value !== 'number') {
    return null;
  }
  return value > 0 ? value : null;
}

export function shouldPersistUserMessage(
  metadata: Record<string, unknown> | null | undefined,
): boolean {
  if (metadata && metadata[SKIP_USER_PERSIST_META] === true) {
    return false;
  }
  return !internalContinuationInbound(metadata);
}

export function shouldStreamBudgetResponse(opts: {
  stop_reason: string;
  pending_queue_available: boolean;
  session_metadata: Record<string, unknown> | null | undefined;
  message_metadata?: Record<string, unknown> | null;
}): boolean {
  if (opts.stop_reason !== 'max_iterations') {
    return true;
  }
  return shouldFinalizeOnMaxIterations({
    pending_queue_available: opts.pending_queue_available,
    session_metadata: opts.session_metadata,
    message_metadata: opts.message_metadata,
  });
}

export function shouldFinalizeOnMaxIterations(opts: {
  pending_queue_available: boolean;
  session_metadata: Record<string, unknown> | null | undefined;
  message_metadata?: Record<string, unknown> | null;
}): boolean {
  return !(
    opts.pending_queue_available &&
    _goalContinuationAvailable(opts.session_metadata, { message_metadata: opts.message_metadata })
  );
}

export async function maybeContinueTurn(ctx: {
  session: { metadata: Record<string, unknown> } | null;
  pending_queue: { put: (msg: unknown) => Promise<void> } | null;
  stop_reason: string;
  msg: {
    sender_id: string;
    content: string;
    media: string[];
    metadata: Record<string, unknown>;
    session_key_override?: string;
  };
  session_key: string;
  all_messages: Record<string, unknown>[];
  final_content: string;
  visible_run_started_at?: number;
  suppress_response?: boolean;
}): Promise<boolean> {
  if (!ctx.session || !ctx.pending_queue) {
    return false;
  }
  if (
    !_continuationAvailable({
      stop_reason: ctx.stop_reason,
      pending_queue_available: true,
      session_metadata: ctx.session.metadata,
      message_metadata: ctx.msg.metadata,
    })
  ) {
    return false;
  }

  const metadata = _internalContinuationMetadata(ctx.msg.metadata, {
    run_started_at: ctx.visible_run_started_at,
  });
  const content = _goalContinuationPrompt(ctx.session.metadata);
  const messages = _stripTerminalAssistant(ctx.all_messages, ctx.final_content);
  _incrementGoalContinuationRound(ctx.session.metadata);

  logger.info('Turn budget reached; scheduling internal continuation');
  ctx.msg.metadata[INTERNAL_CONTINUATION_PENDING_META] = true;
  ctx.final_content = '';
  ctx.all_messages = messages;
  ctx.suppress_response = true;

  const continuationMsg = {
    ...ctx.msg,
    sender_id: _GOAL_CONTINUATION_SENDER,
    content,
    media: [],
    metadata,
    session_key_override: ctx.session_key,
  };

  await ctx.pending_queue.put(continuationMsg);
  return true;
}

export function prepareSaveBoundary(ctx: {
  session?: { metadata: Record<string, unknown> } | null;
  msg: { metadata: Record<string, unknown> };
  initial_messages: unknown[];
  history: unknown[];
  user_persisted_early: boolean;
  save_skip?: number;
}): void {
  if (ctx.session) {
    clearInternalContinuationState(ctx.session.metadata);
  }

  ctx.save_skip = _saveSkipForTurn({
    message_metadata: ctx.msg.metadata,
    initial_message_count: ctx.initial_messages.length,
    history_count: ctx.history.length,
    user_persisted_early: ctx.user_persisted_early,
  });
}

function _continuationAvailable(opts: {
  stop_reason: string;
  pending_queue_available: boolean;
  session_metadata: Record<string, unknown> | null | undefined;
  message_metadata?: Record<string, unknown> | null;
}): boolean {
  if (opts.stop_reason !== 'max_iterations' || !opts.pending_queue_available) {
    return false;
  }
  return _goalContinuationAvailable(opts.session_metadata, {
    message_metadata: opts.message_metadata,
  });
}

export function clearInternalContinuationState(metadata: Record<string, unknown>): void {
  if (!sustainedGoalActive(metadata)) {
    resetGoalContinuationRounds(metadata);
  }
}

export function resetGoalContinuationRounds(metadata: Record<string, unknown>): void {
  delete metadata[_GOAL_CONTINUATION_ROUNDS_KEY];
}

function _saveSkipForTurn(opts: {
  message_metadata: Record<string, unknown>;
  initial_message_count: number;
  history_count: number;
  user_persisted_early: boolean;
}): number {
  if (opts.message_metadata && opts.message_metadata[SKIP_USER_PERSIST_META] === true) {
    return opts.initial_message_count;
  }
  if (internalContinuationInbound(opts.message_metadata)) {
    return opts.initial_message_count;
  }
  const hasStandaloneCurrent = opts.initial_message_count > 1 + opts.history_count;
  if (hasStandaloneCurrent && !opts.user_persisted_early) {
    return opts.initial_message_count - 1;
  }
  return opts.initial_message_count;
}

function _goalContinuationAvailable(
  sessionMetadata: Record<string, unknown> | null | undefined,
  opts: {
    message_metadata?: Record<string, unknown> | null;
    max_rounds?: number;
  } = {},
): boolean {
  if (!sustainedGoalTurn(sessionMetadata, { message_metadata: opts.message_metadata })) {
    return false;
  }
  if (!sustainedGoalActive(sessionMetadata)) {
    return false;
  }
  let rounds = 0;
  try {
    const raw = (sessionMetadata || {})[_GOAL_CONTINUATION_ROUNDS_KEY];
    rounds = typeof raw === 'number' ? Math.floor(raw) : 0;
  } catch {
    rounds = 0;
  }
  const maxRounds = opts.max_rounds ?? _MAX_GOAL_CONTINUATION_ROUNDS;
  return rounds < Math.max(0, maxRounds);
}

function _incrementGoalContinuationRound(sessionMetadata: Record<string, unknown>): void {
  let rounds = 0;
  try {
    const raw = sessionMetadata[_GOAL_CONTINUATION_ROUNDS_KEY];
    rounds = typeof raw === 'number' ? Math.floor(raw) : 0;
  } catch {
    rounds = 0;
  }
  sessionMetadata[_GOAL_CONTINUATION_ROUNDS_KEY] = rounds + 1;
}

function _internalContinuationMetadata(
  messageMetadata: Record<string, unknown> | null | undefined,
  opts: { run_started_at?: number | null } = {},
): Record<string, unknown> {
  const metadata = { ...(messageMetadata || {}) };
  metadata[INTERNAL_CONTINUATION_META] = true;
  metadata[INTERNAL_CONTINUATION_KIND_META] = _GOAL_CONTINUATION_KIND;
  if (opts.run_started_at !== null && opts.run_started_at !== undefined) {
    metadata[INTERNAL_CONTINUATION_RUN_STARTED_AT_META] = opts.run_started_at;
  }
  for (const key of _STRIPPED_INBOUND_META_KEYS) {
    delete metadata[key];
  }
  return metadata;
}

function _goalContinuationPrompt(metadata: Record<string, unknown> | null | undefined): string {
  const lines = goalStateRuntimeLines(metadata);
  if (lines.length > 0) {
    const goal = lines.join('\n');
    return (
      'Continue the active sustained goal after the previous turn reached ' +
      'its tool-call budget.\n\n' +
      `${goal}\n\n` +
      'Continue from the saved context. Do not mention the continuation ' +
      'boundary to the user. Use tools as needed, and call update_goal ' +
      "with action='complete' when the objective is truly finished."
    );
  }
  return (
    'Continue the active sustained goal after the previous turn reached ' +
    'its tool-call budget. Continue from the saved context. Do not mention ' +
    'the continuation boundary to the user. Use tools as needed, and call ' +
    "update_goal with action='complete' when the objective is truly finished."
  );
}

function _stripTerminalAssistant(
  messages: Record<string, unknown>[],
  finalContent: string | null | undefined,
): Record<string, unknown>[] {
  if (messages.length === 0) {
    return messages;
  }
  const last = messages[messages.length - 1];
  if (last['role'] !== 'assistant') {
    return messages;
  }
  if (finalContent === null || finalContent === undefined || last['content'] !== finalContent) {
    return messages;
  }
  if (last['tool_calls']) {
    return messages;
  }
  return messages.slice(0, -1);
}
