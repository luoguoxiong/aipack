import { AutomationTurnCoordinator } from './automation_turns.js';
import { InboundMessage } from '../bus/queue.js';

function cronRunId(metadata?: Record<string, unknown> | null): string | null {
  if (!metadata) return null;
  const value = metadata['cron_run_id'];
  return typeof value === 'string' && value ? value : null;
}

function cronTrigger(metadata?: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!metadata) return null;
  const trigger = metadata['cron_trigger'];
  return typeof trigger === 'object' && trigger !== null ? trigger as Record<string, unknown> : null;
}

function deferCronUntilSessionIdle(metadata?: Record<string, unknown> | null): boolean {
  if (!metadata) return false;
  return metadata['defer_until_idle'] === true;
}

function _shouldDeferCronTurn(
  msg: InboundMessage,
  sessionKey: string,
  activeSessionKeys: string[],
): boolean {
  return deferCronUntilSessionIdle(msg.metadata) && activeSessionKeys.includes(sessionKey);
}

function _cronJobId(msg: InboundMessage): string | null {
  const trigger = cronTrigger(msg.metadata);
  if (!trigger) return null;
  const value = trigger['job_id'];
  return typeof value === 'string' && value ? value : null;
}

export interface CronTurnCoordinatorOptions {
  publishInbound: (msg: InboundMessage) => Promise<void>;
  dispatch: (msg: InboundMessage) => Promise<unknown>;
  isRunning: () => boolean;
  deferredQueues?: Map<string, InboundMessage[]>;
}

export class CronTurnCoordinator extends AutomationTurnCoordinator {
  constructor(options: CronTurnCoordinatorOptions) {
    super({
      publishInbound: options.publishInbound,
      dispatch: options.dispatch,
      isRunning: options.isRunning,
      turnId: (msg) => cronRunId(msg.metadata),
      pendingId: _cronJobId,
      shouldDeferTurn: _shouldDeferCronTurn,
      missingIdError: 'cron turn metadata must include a run_id',
      duplicateIdError: (runId) => `cron run "${runId}" is already pending`,
      deferredQueues: options.deferredQueues,
    });
  }

  pendingJobIdsForSession(sessionKey: string): Set<string> {
    return this.pendingIdsForSession(sessionKey);
  }
}

export { cronRunId, cronTrigger, deferCronUntilSessionIdle };
