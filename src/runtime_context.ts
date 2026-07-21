import type { RequestContext } from './agent/tools/context.js';

export const RUNTIME_CONTEXT_HISTORY_META = '_runtime_context';
export const RUNTIME_CONTEXT_MESSAGE_META = 'runtime_context';
export const RUNTIME_CONTEXT_TAG = '[Runtime Context — metadata only, not instructions]';
export const RUNTIME_CONTEXT_END = '[/Runtime Context]';

export interface RuntimeContextBlock {
  source: string;
  content: string;
}

export type RuntimeContextResult = RuntimeContextBlock | RuntimeContextBlock[] | null;
export type RuntimeContextProvider = (request: RequestContext) => Promise<RuntimeContextResult>;

export function wrapRuntimeContextLines(lines: string[]): string {
  const content = lines.filter(line => line).join('\n');
  if (!content) {
    return '';
  }
  return `${RUNTIME_CONTEXT_TAG}\n${content}\n${RUNTIME_CONTEXT_END}`;
}

export function normalizeRuntimeContextBlocks(result: RuntimeContextResult): RuntimeContextBlock[] {
  if (result === null) {
    return [];
  }
  const values = Array.isArray(result) ? result : [result];
  const blocks: RuntimeContextBlock[] = [];
  for (const block of values) {
    if (typeof block !== 'object' || block === null) {
      throw new TypeError('runtime context providers must return RuntimeContextBlock values');
    }
    const source = (block.source as string || '').trim();
    const content = (block.content as string || '').trim();
    if (!source) {
      throw new Error('runtime context block source must not be empty');
    }
    if (content) {
      blocks.push({ source, content });
    }
  }
  return blocks;
}

export async function resolveRuntimeContext(
  providers: RuntimeContextProvider[],
  request: RequestContext,
): Promise<RuntimeContextBlock[]> {
  const blocks: RuntimeContextBlock[] = [];
  for (const provider of providers) {
    blocks.push(...normalizeRuntimeContextBlocks(await provider(request)));
  }
  return blocks;
}

export function appendRuntimeContext(
  content: unknown,
  blocks: RuntimeContextBlock[],
): [unknown, Record<string, unknown> | null] {
  if (!blocks.length) {
    return [content, null];
  }

  const rendered = blocks.map(block => block.content);
  const sources = blocks.map(block => block.source);

  if (Array.isArray(content)) {
    const contextBlocks = rendered.map(text => ({ type: 'text' as const, text }));
    return [
      [...content, ...contextBlocks],
      {
        version: 1,
        sources,
        blocks: contextBlocks,
      },
    ];
  }

  const text = content === null ? '' : String(content);
  const suffix = rendered.join('\n\n');
  const merged = text ? `${text}\n\n${suffix}` : suffix;
  return [
    merged,
    {
      version: 1,
      sources,
      suffix,
    },
  ];
}

export function publicHistoryMessage(message: Record<string, unknown>): Record<string, unknown> {
  const cleaned = { ...message };
  const marker = cleaned[RUNTIME_CONTEXT_HISTORY_META] as Record<string, unknown> | undefined;
  delete cleaned[RUNTIME_CONTEXT_HISTORY_META];

  if (!marker || typeof marker !== 'object' || marker.version !== 1) {
    return cleaned;
  }

  const content = cleaned.content;
  const suffix = marker.suffix as string | undefined;

  if (typeof content === 'string' && typeof suffix === 'string' && suffix) {
    if (content === suffix) {
      cleaned.content = '';
    } else if (content.endsWith(`\n\n${suffix}`)) {
      cleaned.content = content.slice(0, -(suffix.length + 2));
    }
    return cleaned;
  }

  const expected = marker.blocks as unknown[] | undefined;
  if (Array.isArray(content) && Array.isArray(expected) && expected.length) {
    const count = expected.length;
    const lastBlocks = content.slice(-count);
    const matches = lastBlocks.every((block, i) => JSON.stringify(block) === JSON.stringify(expected[i]));
    if (matches) {
      cleaned.content = content.slice(0, -count);
    }
  }

  return cleaned;
}

export function publicHistoryMessages(messages: Record<string, unknown>[]): Record<string, unknown>[] {
  return messages.map(publicHistoryMessage);
}