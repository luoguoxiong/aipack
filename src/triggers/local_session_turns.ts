import { logger } from '../utils/logger.js';
import { automationHistoryOverridesForSpec, AutomationTurnSpec } from '../session/automation_turns.js';

export const LOCAL_TRIGGER_META_KEY = '_local_trigger';
export const LOCAL_TRIGGER_AUTOMATION_KIND = 'local_trigger';

export const LOCAL_TRIGGER_AUTOMATION_SPEC: AutomationTurnSpec = {
  kind: LOCAL_TRIGGER_AUTOMATION_KIND,
  triggerMetaKey: LOCAL_TRIGGER_META_KEY,
  historyFields: {
    local_trigger_id: 'id',
    local_trigger_name: 'name',
    local_trigger_triggered_at: 'triggered_at',
  },
  textBuilder: (trigger: Record<string, unknown>) => {
    const triggeredAt = String(trigger['triggered_at'] || '').trim();
    if (!triggeredAt) {
      return null;
    }
    const name = String(trigger['name'] || '').trim();
    if (name) {
      return `[Automated local trigger: "${name}" at ${triggeredAt}]`;
    }
    return `[Automated local trigger at ${triggeredAt}]`;
  },
};

export function localTrigger(metadata: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  return automationHistoryOverridesForSpec(metadata, LOCAL_TRIGGER_AUTOMATION_SPEC)[1][LOCAL_TRIGGER_META_KEY] as Record<string, unknown> | null;
}

export function localTriggerHistoryOverrides(
  metadata: Record<string, unknown> | null | undefined,
): [string | null, Record<string, unknown>] {
  return automationHistoryOverridesForSpec(metadata, LOCAL_TRIGGER_AUTOMATION_SPEC);
}

export function isLocalTriggerHistoryMessage(message: Record<string, unknown> | null | undefined): boolean {
  if (!message) {
    return false;
  }
  const marker = message[LOCAL_TRIGGER_META_KEY];
  return marker !== undefined && (marker === true || (typeof marker === 'object' && marker !== null));
}

export function localTriggerTurnMetadataForTrigger(trigger: Record<string, unknown>): Record<string, unknown> {
  const id = String(trigger['id'] || '').trim();
  if (!id) {
    logger.debug({ trigger }, 'local trigger missing id');
    return {};
  }
  const name = String(trigger['name'] || '').trim();
  const triggeredAt = String(trigger['triggered_at'] || new Date().toISOString()).trim();

  return {
    [LOCAL_TRIGGER_META_KEY]: {
      id,
      name,
      triggered_at: triggeredAt,
    },
  };
}