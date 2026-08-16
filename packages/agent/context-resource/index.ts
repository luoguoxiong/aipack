/**
 * packages/context-resource - 上下文资源适配层
 *
 * 将 core 的 Message 体系转换为 ContextResource。
 */

import type {
  Message,
  UserMessage,
  AssistantMessage,
  ToolResultMessage,
  SystemMessage,
  ContentBlock,
  Usage,
} from '../core';
import {
  ContextResourceBuilder,
  createToolResultResource,
} from '../core';
import type { ContextResource, ResourceType, ResourceRole } from '../core';
import { extractToolCalls, extractText } from '../core';

// ─── Message -> ContextResource ───────────────────────────────────

export function messageToResource(msg: Message, index: number): ContextResource {
  const id = `msg_${index}`;
  const timestamp = msg.timestamp ?? Date.now();

  switch (msg.role) {
    case 'user': {
      return new ContextResourceBuilder()
        .id(id)
        .type('user_message')
        .role('user')
        .content(msg.content)
        .timestamp(timestamp)
        .build();
    }

    case 'assistant': {
      const assistant = msg as AssistantMessage;
      const builder = new ContextResourceBuilder()
        .id(id)
        .type('assistant_message')
        .role('assistant')
        .content(assistant.content)
        .timestamp(timestamp)
        .meta('model', assistant.model)
        .meta('provider', assistant.provider)
        .meta('stopReason', assistant.stopReason);

      if (assistant.usage) {
        builder.meta('usage', assistant.usage);
      }

      const toolCalls = extractToolCalls(assistant.content);
      for (const tc of toolCalls) {
        builder.dependsOn(tc.id);
      }

      return builder.build();
    }

    case 'toolResult': {
      const toolMsg = msg as ToolResultMessage;
      return createToolResultResource(
        toolMsg.toolCallId,
        toolMsg.toolName,
        toolMsg.content,
        toolMsg.isError,
        toolMsg.toolCallId,
        { timestamp },
      );
    }

    case 'system': {
      return new ContextResourceBuilder()
        .id(id)
        .type('system_message')
        .role('system')
        .content(msg.content)
        .timestamp(timestamp)
        .pinned()
        .build();
    }

    default: {
      const customMsg = msg as Message & { role: string };
      const roleStr: string = customMsg.role;
      const customType: ResourceType =
        roleStr === 'compactionSummary' ? 'compaction_summary'
        : roleStr === 'stateSnapshot' ? 'state_snapshot'
        : 'custom';

      const builder = new ContextResourceBuilder()
        .id(id)
        .type(customType)
        .role(roleStr as ResourceRole)
        .content(customMsg)
        .timestamp(timestamp);
      // 摘要与状态快照为关键资源：截断类转换器不可移除（pinned）
      if (customType === 'compaction_summary' || customType === 'state_snapshot') {
        builder.pinned();
      }
      return builder.build();
    }
  }
}

export function messagesToResources(messages: Message[]): ContextResource[] {
  return messages.map((msg, index) => messageToResource(msg, index));
}

// ─── ContextResource -> Message ───────────────────────────────────

export function resourceToMessage(resource: ContextResource): Message {
  switch (resource.type) {
    case 'user_message':
      return {
        role: 'user',
        content: resource.content as string | ContentBlock[],
        timestamp: resource.timestamp,
      } as UserMessage;

    case 'assistant_message': {
      const meta = resource.meta;
      const content = resource.content;
      // 标准转换：resource.content 存的是 ContentBlock[]，需重建完整 AssistantMessage
      if (Array.isArray(content)) {
        return {
          role: 'assistant',
          content: content as ContentBlock[],
          stopReason: meta.stopReason as string | undefined,
          usage: meta.usage as Usage | undefined,
          model: meta.model as string | undefined,
          provider: meta.provider as string | undefined,
          timestamp: resource.timestamp,
        } as AssistantMessage;
      }
      // 兼容：content 本身就是完整消息（自定义转换器可能直接存消息）
      return content as AssistantMessage;
    }

    case 'tool_result': {
      const meta = resource.meta;
      return {
        role: 'toolResult',
        toolCallId: meta.toolCallId as string,
        toolName: meta.toolName as string,
        content: resource.content as ContentBlock[],
        isError: meta.isError as boolean,
        timestamp: resource.timestamp,
      } as ToolResultMessage;
    }

    case 'system_message':
      return {
        role: 'system',
        content: resource.content as string,
        timestamp: resource.timestamp,
      } as SystemMessage;

    default:
      return resource.content as Message;
  }
}

export function resourcesToMessages(resources: ContextResource[]): Message[] {
  return resources.map(resourceToMessage);
}

// ─── 工具函数 ─────────────────────────────────────────────────────

export function extractToolCallsFromResource(resource: ContextResource): string[] {
  if (resource.type !== 'assistant_message') return [];
  const content = resource.content as ContentBlock[];
  if (!Array.isArray(content)) return [];
  return extractToolCalls(content).map(tc => tc.id);
}

export function extractTextFromResource(resource: ContextResource): string {
  const content = resource.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return extractText(content);
  return '';
}
