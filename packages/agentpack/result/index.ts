/**
 * packages/result - 运行结果
 *
 * 独立实现，不依赖 src/。
 * 提供 Result 构建和流式结果聚合。
 */

import { ResultBuilder, createResult, createErrorResult } from '../core';
import type { Result, ResultChunk } from '../core';
import type { Message, AssistantMessage, ToolResultMessage, ContentBlock } from '../core';
import { extractText } from '../core';
import type { ContextResource } from '../core';

// ─── 从消息列表构建结果 ───────────────────────────────────────────

/**
 * 从消息列表中提取最终结果
 */
export function buildResultFromMessages(messages: Message[]): Result {
  let content = '';
  let stopReason = 'completed';
  let error: string | undefined;
  const toolsUsed: string[] = [];
  const usage: Record<string, number> = {};

  for (const msg of messages) {
    if (msg.role === 'assistant') {
      const assistant = msg as AssistantMessage;
      content = extractText(assistant.content);
      stopReason = assistant.stopReason ?? 'completed';
      error = assistant.errorMessage;
      if (assistant.usage) {
        usage.input = (usage.input ?? 0) + assistant.usage.input;
        usage.output = (usage.output ?? 0) + assistant.usage.output;
        usage.total = (usage.total ?? 0) + assistant.usage.total;
      }
    }
    if (msg.role === 'toolResult') {
      const toolMsg = msg as ToolResultMessage;
      if (!toolsUsed.includes(toolMsg.toolName)) {
        toolsUsed.push(toolMsg.toolName);
      }
    }
  }

  return new ResultBuilder()
    .content(content)
    .toolsUsed(toolsUsed)
    .usage(usage)
    .stopReason(stopReason)
    .error(error)
    .build();
}

// ─── 从助手消息构建结果 ───────────────────────────────────────────

export function buildResultFromAssistantMessage(
  message: AssistantMessage,
  toolsUsed: string[],
): Result {
  const content = extractText(message.content);

  const builder = new ResultBuilder()
    .content(content)
    .toolsUsed(toolsUsed)
    .stopReason(message.stopReason || 'completed');

  if (message.usage) {
    builder.usage({
      input: message.usage.input,
      output: message.usage.output,
      total: message.usage.total,
    });
  }

  if (message.errorMessage) {
    builder.error(message.errorMessage);
  }

  return builder.build();
}

// ─── 带资源快照的结果 ─────────────────────────────────────────────

export function buildResultWithResources(
  content: string,
  toolsUsed: string[],
  resources: ContextResource[],
  options?: {
    usage?: Record<string, number>;
    stopReason?: string;
    error?: string;
  },
): Result {
  const builder = new ResultBuilder()
    .content(content)
    .toolsUsed(toolsUsed)
    .resources(resources);

  if (options?.usage) builder.usage(options.usage);
  if (options?.stopReason) builder.stopReason(options.stopReason);
  if (options?.error) builder.error(options.error);

  return builder.build();
}

// ─── 流式结果聚合器 ───────────────────────────────────────────────

/**
 * 在流式运行过程中逐步聚合结果。
 */
export class ResultAggregator {
  private content = '';
  private toolsUsed: string[] = [];
  private usage: Record<string, number> = {};
  private stopReason = 'completed';
  private error?: string;
  private chunkCount = 0;

  push(chunk: ResultChunk): void {
    this.chunkCount++;

    switch (chunk.type) {
      case 'text':
        if (chunk.content) this.content += chunk.content;
        break;

      case 'tool_start':
        if (chunk.toolName && !this.toolsUsed.includes(chunk.toolName)) {
          this.toolsUsed.push(chunk.toolName);
        }
        break;

      case 'tool_end':
        break;

      case 'error':
        this.error = chunk.content;
        this.stopReason = 'error';
        break;

      case 'done':
        this.stopReason = this.error ? 'error' : 'completed';
        break;
    }
  }

  build(): Result {
    return new ResultBuilder()
      .content(this.content)
      .toolsUsed(this.toolsUsed)
      .usage(this.usage)
      .stopReason(this.stopReason)
      .error(this.error)
      .build();
  }

  reset(): void {
    this.content = '';
    this.toolsUsed = [];
    this.usage = {};
    this.stopReason = 'completed';
    this.error = undefined;
    this.chunkCount = 0;
  }

  get totalChunks(): number {
    return this.chunkCount;
  }
}

export { ResultBuilder, createResult, createErrorResult } from '../core';
