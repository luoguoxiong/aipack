import { logger } from '../utils/logger.js';
import { automationHistoryOverridesForSpec, AutomationTurnSpec } from '../session/automation_turns.js';

export const CRON_TRIGGER_META_KEY = '_cron';
export const CRON_AUTOMATION_KIND = 'cron';

export const CRON_AUTOMATION_SPEC: AutomationTurnSpec = {
  kind: CRON_AUTOMATION_KIND,
  triggerMetaKey: CRON_TRIGGER_META_KEY,
  legacyHistoryMetaKey: '_cron_turn',
  historyFields: {
    cron_id: 'id',
    cron_name: 'name',
    cron_triggered_at: 'triggered_at',
  },
  textBuilder: (trigger: Record<string, unknown>) => {
    const triggeredAt = String(trigger['triggered_at'] || '').trim();
    if (!triggeredAt) {
      return null;
    }
    const name = String(trigger['name'] || '').trim();
    if (name) {
      return `[Automated cron trigger: "${name}" at ${triggeredAt}]`;
    }
    return `[Automated cron trigger at ${triggeredAt}]`;
  },
};

export function cronTrigger(metadata: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  return automationHistoryOverridesForSpec(metadata, CRON_AUTOMATION_SPEC)[1][CRON_TRIGGER_META_KEY] as Record<string, unknown> | null;
}

export function cronHistoryOverrides(
  metadata: Record<string, unknown> | null | undefined,
): [string | null, Record<string, unknown>] {
  return automationHistoryOverridesForSpec(metadata, CRON_AUTOMATION_SPEC);
}

export function isCronHistoryMessage(message: Record<string, unknown> | null | undefined): boolean {
  if (!message) {
    return false;
  }
  const marker = message[CRON_TRIGGER_META_KEY];
  if (marker === true || (typeof marker === 'object' && marker !== null)) {
    return true;
  }
  if (message['_cron_turn'] === true) {
    return true;
  }
  return false;
}

export function cronTurnMetadataForJob(job: Record<string, unknown>): Record<string, unknown> {
  const id = String(job['id'] || '').trim();
  if (!id) {
    logger.debug({ job }, 'cron job missing id');
    return {};
  }
  const name = String(job['name'] || '').trim();
  const triggeredAt = String(job['triggered_at'] || new Date().toISOString()).trim();

  return {
    [CRON_TRIGGER_META_KEY]: {
      id,
      name,
      triggered_at: triggeredAt,
    },
  };
}