export const UNIFIED_SESSION_KEY = 'unified:default';

export function sessionKeyForChannel(
  channel: string,
  chatId: string,
  opts: { unified_session?: boolean } = {},
): string {
  if (opts.unified_session) {
    return UNIFIED_SESSION_KEY;
  }
  return `${channel}:${chatId}`;
}
