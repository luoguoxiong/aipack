/**
 * 捕获抽取器：把一轮对话（用户消息 + 助手回答 + 工具）压成一条记忆。
 *
 * - 零-LLM 模式（默认）：抽取关键词概念，content 截断为 `Q: ...\nA: ...`。
 * - LLM 模式（可选 summarizeFn）：调用外部摘要函数，失败回退到零-LLM。
 */

import { extractConcepts } from '../retrieval/tokenizer';
import type { SummarizeFn } from '../types';

export interface ExtractResult {
  content: string;
  concepts: string[];
  /** 是否经过 LLM 摘要 */
  summarized: boolean;
}

export interface ExtractorOptions {
  /** 概念数上限，默认 8 */
  maxConcepts?: number;
  /** content 最大字符数，默认 2000 */
  maxChars?: number;
}

/** 截断文本到 maxChars（保留尾部省略号） */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

/**
 * 零-LLM 抽取：content = `Q: <message>\nA: <answer>`（截断），concepts = 关键词 top-N。
 */
export function extractFromTurn(
  userMessage: string,
  assistantContent: string,
  toolsUsed: string[],
  options: ExtractorOptions = {},
): ExtractResult {
  const maxChars = options.maxChars ?? 2000;
  const maxConcepts = options.maxConcepts ?? 8;

  const parts: string[] = [];
  if (userMessage) parts.push(`Q: ${userMessage.trim()}`);
  if (toolsUsed.length > 0) parts.push(`tools: ${toolsUsed.join(', ')}`);
  if (assistantContent) parts.push(`A: ${assistantContent.trim()}`);
  const content = truncate(parts.join('\n'), maxChars);

  const conceptSource = `${userMessage} ${assistantContent} ${toolsUsed.join(' ')}`;
  const concepts = extractConcepts(conceptSource, maxConcepts);

  return { content, concepts, summarized: false };
}

/**
 * 运行抽取：若提供 summarizeFn 则先尝试 LLM 摘要，失败/返回 null 回退到零-LLM。
 */
export async function runCaptureExtractor(
  input: {
    userMessage: string;
    assistantContent: string;
    toolsUsed: string[];
    summarizeFn?: SummarizeFn;
  },
  options: ExtractorOptions = {},
): Promise<ExtractResult> {
  const { userMessage, assistantContent, toolsUsed, summarizeFn } = input;

  if (summarizeFn) {
    try {
      const result = await summarizeFn({
        userMessage,
        assistantContent,
        toolsUsed,
      });
      if (result && result.summary && result.summary.trim()) {
        const maxChars = options.maxChars ?? 2000;
        const concepts =
          result.concepts && result.concepts.length > 0
            ? result.concepts
            : extractConcepts(
                `${userMessage} ${result.summary}`,
                options.maxConcepts ?? 8,
              );
        return {
          content: truncate(result.summary.trim(), maxChars),
          concepts,
          summarized: true,
        };
      }
    } catch {
      // 摘要失败，回退零-LLM
    }
  }

  return extractFromTurn(userMessage, assistantContent, toolsUsed, options);
}
