/**
 * packages/transformer - 上下文转换器
 *
 * 独立实现的 ContextTransformer，不依赖 src/。
 * 提供工具配对修复、状态快照注入、消息截断等内置转换器。
 * 用户可通过 BaseTransformer 实现自定义转换器（如上下文压缩）。
 */

import { BaseTransformer } from '../core';
import type { ContextResource, TransformContext } from '../core';
import type { Message, ToolCallContent, ContentBlock } from '../core';
import { extractToolCalls } from '../core';
import { messagesToResources, resourcesToMessages } from '../context-resource';

// ─── 工具配对转换器 ───────────────────────────────────────────────

/**
 * 确保上下文中 tool_call 与 tool_result 的配对完整性。
 * 移除孤立的工具调用或工具结果消息。
 *
 * 优先级: 10
 */
export class ToolPairingTransformer extends BaseTransformer {
  readonly name = 'tool-pairing';

  constructor() {
    super({ priority: 10 });
  }

  protected async run(
    resources: ContextResource[],
    _context: TransformContext,
  ): Promise<ContextResource[]> {
    const messages = resourcesToMessages(resources);
    const paired = ensureToolPairing(messages);
    return messagesToResources(paired);
  }
}

/**
 * 确保 tool_call 与 tool_result 配对完整
 */
export function ensureToolPairing(messages: Message[]): Message[] {
  const toolCallIds = new Set<string>();
  const toolResultIds = new Set<string>();

  // 收集所有 tool_call ID
  for (const msg of messages) {
    if (msg.role === 'assistant') {
      const content = msg.content;
      if (Array.isArray(content)) {
        for (const tc of extractToolCalls(content)) {
          toolCallIds.add(tc.id);
        }
      }
    }
    if (msg.role === 'toolResult') {
      toolResultIds.add((msg as any).toolCallId);
    }
  }

  // 找出孤立的 tool_call（无对应 result）和孤立的 tool_result（无对应 call）
  const orphanedCalls = new Set<string>();
  const orphanedResults = new Set<string>();

  for (const id of toolCallIds) {
    if (!toolResultIds.has(id)) orphanedCalls.add(id);
  }
  for (const id of toolResultIds) {
    if (!toolCallIds.has(id)) orphanedResults.add(id);
  }

  if (orphanedCalls.size === 0 && orphanedResults.size === 0) {
    return messages;
  }

  // 过滤消息
  const result: Message[] = [];
  for (const msg of messages) {
    if (msg.role === 'assistant') {
      const content = msg.content;
      if (Array.isArray(content)) {
        // 移除孤立的 tool_call
        const filteredContent = content.filter(block => {
          if (block.type === 'toolCall') {
            return !orphanedCalls.has((block as ToolCallContent).id);
          }
          return true;
        });
        // 如果所有内容都被移除，跳过这条消息
        if (filteredContent.length === 0 && content.length > 0) continue;
        result.push({ ...msg, content: filteredContent });
      } else {
        result.push(msg);
      }
    } else if (msg.role === 'toolResult') {
      // 移除孤立的 tool_result
      if (!orphanedResults.has((msg as any).toolCallId)) {
        result.push(msg);
      }
    } else {
      result.push(msg);
    }
  }

  return result;
}

// ─── 状态快照注入转换器 ───────────────────────────────────────────

/**
 * 在上下文开头注入状态快照。
 *
 * 优先级: 30
 */
export class StateSnapshotTransformer extends BaseTransformer {
  readonly name = 'state-snapshot';

  constructor(private getStateSnapshot: () => string | null) {
    super({ priority: 30 });
  }

  protected async run(
    resources: ContextResource[],
    _context: TransformContext,
  ): Promise<ContextResource[]> {
    const snapshot = this.getStateSnapshot();
    if (!snapshot) return resources;

    const snapshotResource: ContextResource = {
      id: `snapshot_${Date.now()}`,
      type: 'state_snapshot',
      role: 'system',
      content: snapshot,
      timestamp: Date.now(),
      dependencies: [],
      meta: { injected: true },
      pinned: true,
    };

    return [snapshotResource, ...resources];
  }
}

// ─── 消息截断转换器 ───────────────────────────────────────────────

/**
 * 当资源总数超过限制时，移除最旧的非关键资源。
 *
 * 优先级: 90
 */
export class TruncationTransformer extends BaseTransformer {
  readonly name = 'truncation';

  constructor(private maxResources: number = 200) {
    super({ priority: 90 });
  }

  protected async run(
    resources: ContextResource[],
    _context: TransformContext,
  ): Promise<ContextResource[]> {
    if (resources.length <= this.maxResources) return resources;

    const pinned = resources.filter(r => r.pinned);
    const unpinned = resources.filter(r => !r.pinned);
    const keepCount = this.maxResources - pinned.length;

    if (keepCount <= 0) return pinned;

    const kept = unpinned.slice(-keepCount);
    return [...pinned, ...kept].sort((a, b) => a.timestamp - b.timestamp);
  }
}

// ─── 系统消息清理转换器 ───────────────────────────────────────────

/**
 * 移除重复的系统消息，只保留最后一条。
 *
 * 优先级: 20
 */
export class SystemMessageCleanerTransformer extends BaseTransformer {
  readonly name = 'system-message-cleaner';

  constructor() {
    super({ priority: 20 });
  }

  protected async run(
    resources: ContextResource[],
    _context: TransformContext,
  ): Promise<ContextResource[]> {
    const systemMessages = resources.filter(r => r.type === 'system_message');
    if (systemMessages.length <= 1) return resources;

    // 保留最后一条系统消息
    const lastSystem = systemMessages[systemMessages.length - 1];
    return resources.filter(r => r.type !== 'system_message' || r === lastSystem);
  }
}

// ─── 转换器工厂 ───────────────────────────────────────────────────

export function createDefaultTransformers(options?: {
  getStateSnapshot?: () => string | null;
  maxResources?: number;
}): import('../core').ContextTransformer[] {
  const transformers: import('../core').ContextTransformer[] = [
    new ToolPairingTransformer(),
    new SystemMessageCleanerTransformer(),
  ];

  if (options?.getStateSnapshot) {
    transformers.push(new StateSnapshotTransformer(options.getStateSnapshot));
  }

  transformers.push(new TruncationTransformer(options?.maxResources ?? 200));

  return transformers;
}
