import { BaseTool, ToolContext, ToolResult, createToolResult, createToolError } from './base.js';
import { z } from 'zod';
import { currentRequestContext } from './context.js';
import { logger } from '../../utils/logger.js';

const GOAL_ACTIONS = ['complete', 'cancel', 'block', 'replace'] as const;
const MAX_GOAL_OBJECTIVE_CHARS = 2000;

const CreateGoalSchema = z.object({
  objective: z.string().min(1).max(MAX_GOAL_OBJECTIVE_CHARS).describe(
    'The sustained objective for this session. It may consolidate a plan from earlier ' +
    'discussion, but must be self-contained, bounded, safe under repetition, and ' +
    'explicit about done-ness.',
  ),
  ui_summary: z.string().max(120).optional().nullable().describe(
    'Optional one-line display label for session lists and logs. It is not load-bearing.',
  ),
});

const UpdateGoalSchema = z.object({
  action: z.enum(GOAL_ACTIONS).describe('How to update the active goal.'),
  recap: z.string().max(8000).optional().nullable().describe(
    'Brief honest recap for the user. Required in practice for complete, cancel, and block.',
  ),
  objective: z.string().max(MAX_GOAL_OBJECTIVE_CHARS).optional().nullable().describe(
    'Replacement objective. Required only when action is \'replace\'; make it durable, ' +
    'self-contained, bounded, and explicit about done-ness.',
  ),
  ui_summary: z.string().max(120).optional().nullable().describe(
    'Optional one-line display label for a replacement goal.',
  ),
});

export interface GoalState {
  status: 'active' | 'completed' | 'cancelled' | 'blocked';
  objective: string;
  ui_summary: string;
  started_at: string;
  ended_at?: string;
  completed_at?: string;
  replaced_at?: string;
  previous_objective?: string;
  recap?: string;
}

export interface SessionLike {
  metadata: Record<string, unknown>;
  save?(): Promise<void>;
}

export interface SessionManagerLike {
  getOrCreate(sessionKey: string): SessionLike;
  save(session: SessionLike): Promise<void>;
}

export interface RuntimeEventBusLike {
  publish(event: unknown): Promise<void>;
}

const GOAL_STATE_KEY = 'goal_state';

function isoNow(): string {
  return new Date().toISOString();
}

function parseGoalState(raw: unknown): GoalState | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.status !== 'string') return null;
  if (typeof obj.objective !== 'string') return null;
  return obj as unknown as GoalState;
}

function goalStateRaw(metadata: Record<string, unknown>): unknown {
  return metadata[GOAL_STATE_KEY];
}

function sustainedGoalActive(metadata: Record<string, unknown>): boolean {
  const state = parseGoalState(goalStateRaw(metadata));
  return state !== null && state.status === 'active';
}

function explicitGoalRequested(metadata: Record<string, unknown>): boolean {
  return Boolean(metadata['_goal_requested']);
}

function goalMutationAllowed(metadata: Record<string, unknown>): boolean {
  return Boolean(metadata['_goal_mutation_allowed']);
}

function discardLegacyGoalStateKey(metadata: Record<string, unknown>): void {
  delete metadata['goal'];
}

function resetGoalContinuationRounds(metadata: Record<string, unknown>): void {
  delete metadata['_goal_continuation_rounds'];
}

abstract class GoalToolsMixin {
  protected _sessions: SessionManagerLike | null;
  protected _runtime_events: RuntimeEventBusLike | null;

  constructor(sessions?: SessionManagerLike, runtimeEvents?: RuntimeEventBusLike) {
    this._sessions = sessions ?? null;
    this._runtime_events = runtimeEvents ?? null;
  }

  protected _session(): SessionLike | null {
    const requestCtx = currentRequestContext();
    if (!requestCtx) return null;
    const key = requestCtx.session_key;
    if (!key) return null;
    if (!this._sessions) return null;
    return this._sessions.getOrCreate(key);
  }

  protected _goalMutationAllowed(): boolean {
    const ctx = currentRequestContext();
    if (!ctx) return false;
    return goalMutationAllowed(ctx.metadata);
  }

  protected async _saveGoalState(
    sess: SessionLike,
    blob: GoalState,
    options?: { resetContinuation?: boolean },
  ): Promise<void> {
    const previousMetadata = JSON.parse(JSON.stringify(sess.metadata));
    sess.metadata[GOAL_STATE_KEY] = blob;
    discardLegacyGoalStateKey(sess.metadata);
    if (options?.resetContinuation) {
      resetGoalContinuationRounds(sess.metadata);
    }
    try {
      if (this._sessions?.save) {
        await this._sessions.save(sess);
      } else if (sess.save) {
        await sess.save();
      }
    } catch (e) {
      sess.metadata = previousMetadata;
      throw e;
    }
  }

  protected async _publishGoalStateChanged(metadata: Record<string, unknown>): Promise<void> {
    if (!this._runtime_events) return;
    const rc = currentRequestContext();
    if (!rc) return;
    const cid = (rc.chat_id || '').trim();
    if (!cid) return;
    try {
      await this._runtime_events.publish({
        type: 'goal_state_changed',
        context: {
          channel: rc.channel,
          chat_id: cid,
          session_key: rc.session_key || `${rc.channel}:${cid}`,
          metadata: { ...(rc.metadata || {}) },
        },
        session_metadata: { ...metadata },
      });
    } catch (e) {
      logger.warn({ error: (e as Error).message }, 'Failed to publish goal state change');
    }
  }
}

export class CreateGoalTool extends BaseTool {
  name = 'create_goal';
  description = (
    'Create one sustained goal for the current session when Goal Runtime Guidance asks ' +
    'you to record it. Consolidate relevant prior discussion into a durable objective ' +
    'that is self-contained, bounded, safe under repetition, and explicit about ' +
    'completion criteria. Do not retry after a successful creation.'
  );
  input_schema = CreateGoalSchema;
  tags = ['goal', 'long_task'];

  private _mixin: GoalToolsMixin;

  constructor(sessions?: SessionManagerLike, runtimeEvents?: RuntimeEventBusLike) {
    super();
    this._mixin = new (class extends GoalToolsMixin {})(sessions, runtimeEvents);
  }

  async execute(args: unknown, _context: ToolContext): Promise<ToolResult> {
    try {
      const params = this.input_schema.parse(args);
      const sess = (this._mixin as any)._session?.() || null;
      if (!sess) {
        return createToolError(
          'Error: create_goal requires an active chat session (missing routing context).',
        );
      }
      if (!(this._mixin as any)._goalMutationAllowed?.()) {
        return createToolError(
          'Error: create_goal is unavailable for this turn. Ask the user to submit the complete ' +
          'objective as `/goal <task>`.',
        );
      }
      const prior = parseGoalState(goalStateRaw(sess.metadata));
      if (prior && prior.status === 'active') {
        return createToolError(
          'Error: a sustained goal is already active. Use update_goal with ' +
          "action='replace' only if the user explicitly changes the objective.",
        );
      }

      const objectiveText = params.objective.trim();
      if (!objectiveText) {
        return createToolError('Error: objective must not be empty.');
      }
      if (objectiveText.length > MAX_GOAL_OBJECTIVE_CHARS) {
        return createToolError(
          `Error: objective must not exceed ${MAX_GOAL_OBJECTIVE_CHARS} characters.`,
        );
      }
      const summary = (params.ui_summary || '').trim().slice(0, 120);
      const blob: GoalState = {
        status: 'active',
        objective: objectiveText,
        ui_summary: summary,
        started_at: isoNow(),
      };
      await (this._mixin as any)._saveGoalState(sess, blob, { resetContinuation: true });
      await (this._mixin as any)._publishGoalStateChanged(sess.metadata);
      const extra = summary ? `\nSummary line: ${summary}` : '';
      return createToolResult(
        'Goal recorded. Keep working toward the objective using ordinary tools. ' +
        "When fully done and verified, call update_goal with action='complete'." +
        extra,
      );
    } catch (e) {
      return createToolError(`Error: ${(e as Error).message}`);
    }
  }
}

export class UpdateGoalTool extends BaseTool {
  name = 'update_goal';
  description = (
    'Update the active sustained goal. Use action=\'complete\' only after the objective ' +
    'is actually achieved and verified. Use action=\'cancel\' when the user cancels, ' +
    "action='block' when progress is genuinely blocked, and action='replace' only when " +
    'the requested objective changes.'
  );
  input_schema = UpdateGoalSchema;
  tags = ['goal', 'long_task'];

  private _mixin: GoalToolsMixin;

  constructor(sessions?: SessionManagerLike, runtimeEvents?: RuntimeEventBusLike) {
    super();
    this._mixin = new (class extends GoalToolsMixin {})(sessions, runtimeEvents);
  }

  async execute(args: unknown, _context: ToolContext): Promise<ToolResult> {
    try {
      const params = this.input_schema.parse(args);
      const sess = (this._mixin as any)._session?.() || null;
      if (!sess) {
        return createToolError('Error: update_goal requires an active chat session.');
      }
      const prior = parseGoalState(goalStateRaw(sess.metadata));
      if (!prior || prior.status !== 'active') {
        return createToolResult('No active goal to update.');
      }

      const normalized = (params.action || '').trim().toLowerCase();
      if (!GOAL_ACTIONS.includes(normalized as typeof GOAL_ACTIONS[number])) {
        return createToolError(
          'Error: action must be one of complete, cancel, block, or replace.',
        );
      }

      if (normalized === 'replace') {
        if (!(this._mixin as any)._goalMutationAllowed?.()) {
          return createToolError(
            'Error: replacing the goal is unavailable for this turn. Ask the user to submit the ' +
            'replacement objective as `/goal <task>`.',
          );
        }
        const objectiveText = (params.objective || '').trim();
        if (!objectiveText) {
          return createToolError(
            "Error: update_goal action='replace' requires a replacement objective.",
          );
        }
        if (objectiveText.length > MAX_GOAL_OBJECTIVE_CHARS) {
          return createToolError(
            `Error: objective must not exceed ${MAX_GOAL_OBJECTIVE_CHARS} characters.`,
          );
        }
        const summary = (params.ui_summary || '').trim().slice(0, 120);
        const blob: GoalState = {
          status: 'active',
          objective: objectiveText,
          ui_summary: summary,
          started_at: isoNow(),
          replaced_at: isoNow(),
          previous_objective: prior.objective,
          recap: (params.recap || '').trim(),
        };
        await (this._mixin as any)._saveGoalState(sess, blob, { resetContinuation: true });
        await (this._mixin as any)._publishGoalStateChanged(sess.metadata);
        const extra = summary ? `\nSummary line: ${summary}` : '';
        return createToolResult('Goal replaced. Continue toward the new objective using ordinary tools.' + extra);
      }

      const ended = isoNow();
      const statusMap: Record<string, 'completed' | 'cancelled' | 'blocked'> = {
        complete: 'completed',
        cancel: 'cancelled',
        block: 'blocked',
      };
      const status = statusMap[normalized];
      const blob: GoalState = {
        ...prior,
        status,
        ended_at: ended,
        recap: (params.recap || '').trim(),
      };
      if (normalized === 'complete') {
        blob.completed_at = ended;
      }
      await (this._mixin as any)._saveGoalState(sess, blob);
      await (this._mixin as any)._publishGoalStateChanged(sess.metadata);

      const tail = (params.recap || '').trim();
      const labelMap: Record<string, string> = {
        complete: 'complete',
        cancel: 'cancelled',
        block: 'blocked',
      };
      const label = labelMap[normalized];
      if (tail) {
        return createToolResult(`Goal marked ${label} (${ended}). Recap:\n${tail}`);
      }
      return createToolResult(`Goal marked ${label} (${ended}).`);
    } catch (e) {
      return createToolError(`Error: ${(e as Error).message}`);
    }
  }
}

export function getLongTaskTools(sessions?: SessionManagerLike, runtimeEvents?: RuntimeEventBusLike): BaseTool[] {
  return [
    new CreateGoalTool(sessions, runtimeEvents),
    new UpdateGoalTool(sessions, runtimeEvents),
  ];
}

export {
  GOAL_STATE_KEY,
  MAX_GOAL_OBJECTIVE_CHARS,
  parseGoalState,
  goalStateRaw,
  sustainedGoalActive,
  explicitGoalRequested,
};
