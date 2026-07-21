import crypto from 'crypto';

export function generateId(prefix = ''): string {
  const id = crypto.randomBytes(8).toString('hex');
  return prefix ? `${prefix}_${id}` : id;
}

export function generateTurnId(): string {
  return `turn_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + '...';
}

export function isBlankText(text: string | null | undefined): boolean {
  return !text || !text.trim();
}

export function abbreviatePath(filePath: string, maxLen = 40): string {
  if (filePath.length <= maxLen) return filePath;
  const parts = filePath.split(/[\\/]/);
  if (parts.length <= 2) return filePath.slice(0, maxLen - 3) + '...';
  
  const last = parts[parts.length - 1];
  const first = parts[0];
  const remaining = maxLen - first.length - last.length - 5;
  
  if (remaining <= 0) return '.../' + last;
  
  return `${first}/.../${last}`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '').trim();
}

export function sanitizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (['http:', 'https:'].includes(parsed.protocol)) {
      return url;
    }
    throw new Error('Invalid protocol');
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
}

export function buildAssistantMessage(content: string | unknown[], toolCalls?: unknown[]): Record<string, unknown> {
  const msg: Record<string, unknown> = {
    role: 'assistant',
    content,
  };
  if (toolCalls && toolCalls.length > 0) {
    msg.tool_calls = toolCalls;
  }
  return msg;
}

export function extractReasoning(content: string): { reasoning: string | null; text: string } {
  const thinkMatch = content.match(/<think>([\s\S]*?)<\/think>/);
  if (thinkMatch) {
    return {
      reasoning: thinkMatch[1].trim(),
      text: content.replace(/<think>[\s\S]*?<\/think>/g, '').trim(),
    };
  }
  return { reasoning: null, text: content };
}

export function stripThinkTags(content: string): string {
  return content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

export function stripReasoningTags(content: string): string {
  return stripThinkTags(content);
}
