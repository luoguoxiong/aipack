import { toolArgumentsJsonForReplay } from '../base.js';

export function convertMessages(messages: Record<string, unknown>[]): [string, Record<string, unknown>[]] {
  let systemPrompt = '';
  const inputItems: Record<string, unknown>[] = [];
  const usedItemIds = new Set<string>();

  for (let idx = 0; idx < messages.length; idx++) {
    const msg = messages[idx];
    const role = msg.role as string | undefined;
    const content = msg.content;

    if (role === 'system') {
      systemPrompt = typeof content === 'string' ? content : '';
      continue;
    }

    if (role === 'user') {
      inputItems.push(convertUserMessage(content));
      continue;
    }

    if (role === 'assistant') {
      if (typeof content === 'string' && content) {
        const messageId = uniqueItemId(`msg_${idx}`, usedItemIds);
        inputItems.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: content }],
          status: 'completed',
          id: messageId,
        });
      }
      const toolCalls = (msg.tool_calls as Record<string, unknown>[] | undefined) || [];
      for (const toolCall of toolCalls) {
        const fn = (toolCall.function as Record<string, unknown> | undefined) || {};
        const [callId, itemId] = splitToolCallId(toolCall.id);
        const responseItemId = uniqueItemId(itemId || `fc_${idx}`, usedItemIds);
        inputItems.push({
          type: 'function_call',
          id: responseItemId,
          call_id: callId || `call_${idx}`,
          name: fn.name,
          arguments: toolArgumentsJsonForReplay(fn.arguments),
        });
      }
      continue;
    }

    if (role === 'tool') {
      const [callId] = splitToolCallId(msg.tool_call_id);
      const outputText = typeof content === 'string'
        ? content
        : JSON.stringify(content);
      inputItems.push({
        type: 'function_call_output',
        call_id: callId,
        output: outputText,
      });
    }
  }

  return [systemPrompt, inputItems];
}

export function convertUserMessage(content: unknown): Record<string, unknown> {
  if (typeof content === 'string') {
    return { role: 'user', content: [{ type: 'input_text', text: content }] };
  }
  if (Array.isArray(content)) {
    const converted: Record<string, unknown>[] = [];
    for (const item of content) {
      if (typeof item !== 'object' || item === null) continue;
      const itemObj = item as Record<string, unknown>;
      if (itemObj.type === 'text') {
        converted.push({ type: 'input_text', text: itemObj.text ?? '' });
      } else if (itemObj.type === 'image_url') {
        const imageUrl = (itemObj.image_url as Record<string, unknown> | undefined)?.url;
        if (imageUrl) {
          converted.push({ type: 'input_image', image_url: imageUrl, detail: 'auto' });
        }
      }
    }
    if (converted.length > 0) {
      return { role: 'user', content: converted };
    }
  }
  return { role: 'user', content: [{ type: 'input_text', text: '' }] };
}

export function convertTools(tools: Record<string, unknown>[]): Record<string, unknown>[] {
  const converted: Record<string, unknown>[] = [];
  for (const tool of tools) {
    const fn = tool.type === 'function'
      ? (tool.function as Record<string, unknown> | undefined) || tool
      : tool;
    const name = fn.name as string | undefined;
    if (!name) continue;
    const params = (fn.parameters as Record<string, unknown> | undefined) || {};
    converted.push({
      type: 'function',
      name,
      description: (fn.description as string | undefined) || '',
      parameters: typeof params === 'object' && params !== null ? params : {},
    });
  }
  return converted;
}

function uniqueItemId(itemId: string, used: Set<string>): string {
  if (!used.has(itemId)) {
    used.add(itemId);
    return itemId;
  }
  let suffix = 2;
  while (used.has(`${itemId}_${suffix}`)) {
    suffix++;
  }
  const unique = `${itemId}_${suffix}`;
  used.add(unique);
  return unique;
}

export function splitToolCallId(toolCallId: unknown): [string, string | null] {
  if (typeof toolCallId === 'string' && toolCallId) {
    if (toolCallId.includes('|')) {
      const [callId, itemId] = toolCallId.split('|', 2);
      return [callId, itemId || null];
    }
    return [toolCallId, null];
  }
  return ['call_0', null];
}
