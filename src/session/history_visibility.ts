export const HIDDEN_HISTORY_META = '_hidden_history';

function hasHiddenHistoryMarker(message: Record<string, unknown> | null | undefined): boolean {
  if (!message) {
    return false;
  }
  const marker = message[HIDDEN_HISTORY_META];
  return marker === true || (typeof marker === 'object' && marker !== null);
}

export function isHiddenHistoryMessage(message: Record<string, unknown> | null | undefined): boolean {
  return hasHiddenHistoryMarker(message) || isAutomationHistoryMessage(message);
}

function isAutomationHistoryMessage(message: Record<string, unknown> | null | undefined): boolean {
  if (!message) {
    return false;
  }
  const metadata = message['metadata'] as Record<string, unknown> | undefined;
  if (!metadata) {
    return false;
  }
  return Boolean(metadata['_automation_history']);
}
