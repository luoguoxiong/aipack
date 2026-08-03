/**
 * packages/task-graph - 任务依赖图
 *
 * 将 Message 列表构建为 webpack 风格的 TaskGraph。
 * 自动分析 tool_call -> tool_result 的依赖关系。
 *
 * Webpack 映射: Dependency Graph
 */

import type { Message, AssistantMessage, ToolCallContent, ContentBlock } from '../core';
import { extractToolCalls } from '../core';
import { createTaskGraph, TaskGraphBuilder } from '../core';
import type { TaskGraph, ContextResource } from '../core';
import { messagesToResources, resourcesToMessages } from '../context-resource';

// ─── 构建图 ───────────────────────────────────────────────────────

export function buildTaskGraph(messages: Message[]): TaskGraph {
  const resources = messagesToResources(messages);

  // 补充 tool_call -> tool_result 依赖
  const toolCallIndices = new Map<string, number>();
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'assistant') {
      const content = messages[i].content;
      if (Array.isArray(content)) {
        for (const tc of extractToolCalls(content)) {
          toolCallIndices.set(tc.id, i);
        }
      }
    }
  }

  for (let i = 0; i < resources.length; i++) {
    const res = resources[i];
    if (res.type === 'tool_result') {
      const toolCallId = res.meta.toolCallId as string;
      if (toolCallId) {
        const assistantIdx = toolCallIndices.get(toolCallId);
        if (assistantIdx !== undefined) {
          resources[i] = {
            ...res,
            dependencies: [...res.dependencies, `msg_${assistantIdx}`],
          };
        }
      }
    }
  }

  const builder = new TaskGraphBuilder();
  builder.addAll(resources);
  return builder.build();
}

export function graphToMessages(graph: TaskGraph): Message[] {
  const sorted = graph.topologicalSort();
  return resourcesToMessages(sorted);
}

// ─── 图分析 ───────────────────────────────────────────────────────

/**
 * 分析工具调用链
 *
 * tool_call 存在于 assistant_message 资源的 content 块中，
 * tool_result 是独立的 tool_result 资源，通过 meta.toolCallId 关联。
 */
export function analyzeToolChains(graph: TaskGraph): Array<{
  toolCallId: string;
  toolName: string;
  hasResult: boolean;
  isError: boolean;
}> {
  // 1. 收集所有 tool_result
  const toolResults = graph.getByType('tool_result');
  const resultMap = new Map<string, ContextResource>();
  for (const result of toolResults) {
    const tcId = result.meta.toolCallId as string;
    if (tcId) resultMap.set(tcId, result);
  }

  // 2. 从 assistant_message 资源中提取 tool_call
  const chains: Array<{ toolCallId: string; toolName: string; hasResult: boolean; isError: boolean }> = [];
  const seen = new Set<string>();

  for (const res of graph.getByType('assistant_message')) {
    const content = res.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (block?.type !== 'toolCall') continue;
      const tc = block as ToolCallContent;
      if (seen.has(tc.id)) continue;
      seen.add(tc.id);

      const result = resultMap.get(tc.id);
      chains.push({
        toolCallId: tc.id,
        toolName: tc.name,
        hasResult: !!result,
        isError: result?.meta.isError as boolean ?? false,
      });
    }
  }

  return chains;
}

export function findOrphanedToolCalls(graph: TaskGraph): string[] {
  return analyzeToolChains(graph)
    .filter(chain => !chain.hasResult)
    .map(chain => chain.toolCallId);
}

export function getGraphStats(graph: TaskGraph): {
  total: number;
  byType: Record<string, number>;
  orphanedToolCalls: number;
  hasErrors: boolean;
} {
  const resources = graph.getAll();
  const byType: Record<string, number> = {};
  let hasErrors = false;

  for (const res of resources) {
    byType[res.type] = (byType[res.type] || 0) + 1;
    if (res.meta.isError === true) hasErrors = true;
  }

  return {
    total: resources.length,
    byType,
    orphanedToolCalls: findOrphanedToolCalls(graph).length,
    hasErrors,
  };
}
