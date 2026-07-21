const _SUBAGENT_CHANNEL_RESULT_MAX_CHARS = 800;

export function scrubSubagentAnnounceBody(content: string): string {
  const stripped = content.replace(/\r\n/g, '\n').trim();
  const lines = stripped.split('\n');
  let header = '';

  if (lines.length && lines[0].startsWith('[Subagent')) {
    header = lines[0].trim();
  }

  const lower = stripped.toLowerCase();
  let key = '\nresult:\n';
  let ri = lower.indexOf(key);

  if (ri === -1) {
    key = '\nresult:';
    ri = lower.indexOf(key);
  }

  if (ri === -1) {
    return header || stripped;
  }

  let after = stripped.slice(ri + key.length).trimStart();
  const summMarker = 'summarize this naturally';
  const si = after.toLowerCase().indexOf(summMarker);

  if (si !== -1) {
    after = after.slice(0, si).trimEnd();
  }

  let body = after.trim();
  const limit = _SUBAGENT_CHANNEL_RESULT_MAX_CHARS;

  if (limit && body.length > limit) {
    body = body.slice(0, limit - 1).trimEnd() + '…';
  }

  if (header && body) {
    return `${header}\n\n${body}`;
  }

  return header || body || stripped;
}

export function scrubSubagentMessagesForChannel(messages: Array<Record<string, unknown>>): void {
  for (const msg of messages) {
    if (typeof msg !== 'object' || msg === null) continue;
    if (msg.injected_event !== 'subagent_result') continue;

    const raw = msg.content;
    if (typeof raw !== 'string' || !raw.trim()) continue;

    msg.content = scrubSubagentAnnounceBody(raw);
  }
}