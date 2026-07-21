import type { SessionManager } from './manager.js';

export const GOAL_STATE_KEY = 'goal_state';
export const GOAL_COMMAND = '/goal';
export const MAX_GOAL_OBJECTIVE_CHARS = 4000;

const _LEGACY_GOAL_STATE_SESSION_KEY = 'thread_goal';
const _MAX_OBJECTIVE_WS = 600;

function sessionGoalRaw(metadata: Record<string, unknown> | null | undefined): unknown {
  if (!metadata) {
    return null;
  }
  if (GOAL_STATE_KEY in metadata) {
    return metadata[GOAL_STATE_KEY];
  }
  return metadata[_LEGACY_GOAL_STATE_SESSION_KEY];
}

export function discardLegacyGoalStateKey(metadata: Record<string, unknown>): void {
  delete metadata[_LEGACY_GOAL_STATE_SESSION_KEY];
}

export function goalStateRaw(metadata: Record<string, unknown> | null | undefined): unknown {
  return sessionGoalRaw(metadata);
}

export function sustainedGoalActive(metadata: Record<string, unknown> | null | undefined): boolean {
  const goal = parseGoalState(goalStateRaw(metadata));
  return typeof goal === 'object' && goal !== null && goal['status'] === 'active';
}

export function explicitGoalRequested(
  messageMetadata: Record<string, unknown> | null | undefined,
): boolean {
  if (!messageMetadata) {
    return false;
  }
  if (messageMetadata['goal_requested'] === true) {
    return true;
  }
  return String(messageMetadata['original_command'] || '').trim() === GOAL_COMMAND;
}

export function sustainedGoalTurn(
  metadata: Record<string, unknown> | null | undefined,
  opts: { message_metadata?: Record<string, unknown> | null } = {},
): boolean {
  return sustainedGoalActive(metadata) || explicitGoalRequested(opts.message_metadata);
}

export function parseGoalState(blob: unknown): Record<string, unknown> | null {
  if (blob === null || blob === undefined) {
    return null;
  }
  if (typeof blob === 'object' && blob !== null) {
    return blob as Record<string, unknown>;
  }
  if (typeof blob === 'string') {
    try {
      const parsed = JSON.parse(blob);
      return typeof parsed === 'object' && parsed !== null ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

export function goalStateRuntimeLines(metadata: Record<string, unknown> | null | undefined): string[] {
  if (!metadata) {
    return [];
  }
  const goal = parseGoalState(sessionGoalRaw(metadata));
  if (!goal || goal['status'] !== 'active') {
    return [];
  }
  const objective = String(goal['objective'] || '').trim();
  if (!objective) {
    return ['Goal: active (no objective text stored).'];
  }
  let outObjective = objective;
  if (outObjective.length > MAX_GOAL_OBJECTIVE_CHARS) {
    outObjective = outObjective.slice(0, MAX_GOAL_OBJECTIVE_CHARS).trimEnd() + '\n… (truncated)';
  }
  const out: string[] = ['Goal (active):', outObjective];
  const hint = String(goal['ui_summary'] || '').trim();
  if (hint) {
    out.push(`Summary: ${hint}`);
  }
  return out;
}

export function goalStateWsBlob(metadata: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const goal = metadata ? parseGoalState(sessionGoalRaw(metadata)) : null;
  if (goal && goal['status'] === 'active') {
    let objective = String(goal['objective'] || '').trim();
    if (objective.length > _MAX_OBJECTIVE_WS) {
      objective = objective.slice(0, _MAX_OBJECTIVE_WS).trimEnd() + '…';
    }
    const summary = String(goal['ui_summary'] || '').trim().slice(0, 120);
    const blob: Record<string, unknown> = { active: true };
    if (summary) {
      blob['ui_summary'] = summary;
    }
    if (objective) {
      blob['objective'] = objective;
    }
    return blob;
  }
  return { active: false };
}

export function runnerWallLLMTimeoutS(
  sessions: SessionManager,
  sessionKey: string | null | undefined,
  opts: {
    metadata?: Record<string, unknown> | null;
    message_metadata?: Record<string, unknown> | null;
  } = {},
): number | null {
  let meta: Record<string, unknown> | null | undefined = opts.metadata;
  if (!meta && sessionKey) {
    // Note: In TS version, sessions.getSession returns a Promise
    // Caller should pass metadata directly if available
  }
  return sustainedGoalTurn(meta, { message_metadata: opts.message_metadata }) ? 0.0 : null;
}
