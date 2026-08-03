// ─── SSE 解析 ──────────────────────────────────────────────────
// 统一 SSE 解析器，供 stream-openai / stream-anthropic 共用

export interface SSEEvent {
  /** event: 行指定的事件类型，缺省为 'message' */
  event?: string;
  /** data: 行的原始内容（已去前缀） */
  data?: string;
}

/**
 * 按 `\n\n` 分隔解析完整的 SSE 事件块。
 * 每块可包含 event:、data:、id:、retry: 等行。
 * 适用于 Anthropic 风格的流式响应。
 */
export function parseSSEEvents(buffer: string): { events: SSEEvent[]; remaining: string } {
  const events: SSEEvent[] = [];
  let remaining = buffer;

  while (true) {
    const dblNl = remaining.indexOf('\n\n');
    if (dblNl === -1) break;

    const block = remaining.slice(0, dblNl);
    remaining = remaining.slice(dblNl + 2);

    let eventType: string | undefined;
    let dataStr = '';

    for (const line of block.split('\n')) {
      const trimmed = line.replace(/\r$/, '');
      if (trimmed.startsWith('event:')) {
        eventType = trimmed.slice(6).trim();
      } else if (trimmed.startsWith('data:')) {
        dataStr += trimmed.slice(5).trimStart();
      }
      // id: / retry: 行暂不处理
    }

    if (dataStr) {
      events.push({ event: eventType ?? 'message', data: dataStr });
    }
  }

  return { events, remaining };
}

/**
 * 从缓冲区中提取所有 data: 行的内容，忽略 event: / : 注释行。
 * 不按 `\n\n` 切分，适用于 OpenAI 风格的流式响应。
 */
export function extractDataLines(buffer: string): { lines: string[]; rest: string } {
  const lines: string[] = [];
  let rest = buffer;
  let nl: number;

  while ((nl = rest.indexOf('\n')) !== -1) {
    const line = rest.slice(0, nl).replace(/\r$/, '');
    rest = rest.slice(nl + 1);
    if (line.startsWith('data:')) {
      lines.push(line.slice(5).trimStart());
    }
    // 忽略 event: / : 注释行
  }

  return { lines, rest };
}

/**
 * 将 data 行解析为 JSON，跳过空行和 [DONE] 终结标记。
 * OpenAI 流中常用于判断流是否结束。
 */
export function tryParseJSON<T = unknown>(data: string): { value: T } | null {
  if (!data || data === '[DONE]') return null;
  try {
    return { value: JSON.parse(data) as T };
  } catch {
    return null;
  }
}
