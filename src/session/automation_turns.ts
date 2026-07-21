export const AUTOMATION_HISTORY_META = '_automation_turn';

export interface AutomationTurnSpec {
  kind: string;
  triggerMetaKey: string;
  legacyHistoryMetaKey?: string | null;
  historyFields: Record<string, string>;
  textBuilder?: ((trigger: Record<string, unknown>) => string | null) | null;
}

export function automationTrigger(
  metadata: Record<string, unknown> | null | undefined,
  spec: AutomationTurnSpec,
): Record<string, unknown> | null {
  const raw = metadata?.[spec.triggerMetaKey];
  return typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : null;
}

export function automationHistoryOverridesForSpec(
  metadata: Record<string, unknown> | null | undefined,
  spec: AutomationTurnSpec,
): [string | null, Record<string, unknown>] {
  const trigger = automationTrigger(metadata, spec);
  if (!trigger) {
    return [null, {}];
  }

  const details: Record<string, unknown> = { kind: spec.kind };
  const extra: Record<string, unknown> = { [AUTOMATION_HISTORY_META]: details };

  if (spec.legacyHistoryMetaKey) {
    extra[spec.legacyHistoryMetaKey] = true;
  }

  for (const [historyKey, triggerKey] of Object.entries(spec.historyFields)) {
    const value = trigger[triggerKey];
    extra[historyKey] = value;
    details[historyKey] = value;
  }

  const text = spec.textBuilder?.(trigger) ?? null;
  return [text, extra];
}

let automationSpecs: AutomationTurnSpec[] | null = null;

function getAutomationSpecs(): AutomationTurnSpec[] {
  if (automationSpecs === null) {
    try {
      const { CRON_AUTOMATION_SPEC } = require('../cron/session_turns.js');
      const { LOCAL_TRIGGER_AUTOMATION_SPEC } = require('../triggers/local_session_turns.js');
      automationSpecs = [CRON_AUTOMATION_SPEC, LOCAL_TRIGGER_AUTOMATION_SPEC];
    } catch {
      automationSpecs = [];
    }
  }
  return automationSpecs;
}

export function automationHistoryOverrides(
  metadata: Record<string, unknown> | null | undefined,
): [string | null, Record<string, unknown>] {
  for (const spec of getAutomationSpecs()) {
    const [text, extra] = automationHistoryOverridesForSpec(metadata, spec);
    if (Object.keys(extra).length > 0) {
      return [text, extra];
    }
  }
  return [null, {}];
}

export function isAutomationHistoryMessage(message: Record<string, unknown> | null | undefined): boolean {
  if (!message) {
    return false;
  }
  const marker = message[AUTOMATION_HISTORY_META];
  if (marker === true || (typeof marker === 'object' && marker !== null)) {
    return true;
  }
  for (const spec of getAutomationSpecs()) {
    if (spec.legacyHistoryMetaKey && message[spec.legacyHistoryMetaKey] === true) {
      return true;
    }
  }
  return false;
}

export function isAutomationKind(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  if (value === 'trigger') {
    return true;
  }
  for (const spec of getAutomationSpecs()) {
    if (spec.kind === value) {
      return true;
    }
  }
  return false;
}