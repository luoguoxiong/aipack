/**
 * Agent 可调用的记忆工具。
 *
 * 参考 agentmemory 的 MCP 工具（save / recall / sessions 等），
 * 但以 agentpack 原生 Tool 形式提供，parameters 用纯 JSON Schema（不依赖 TypeBox）。
 *
 * 工具列表：
 *   - save_memory(content, concepts?)
 *   - search_memory(query, limit?)
 *   - list_memories(limit?)
 *   - delete_memory(id)
 */

import type { Tool, ToolResult } from 'agentpack';
import { createTextContent } from 'agentpack';
import type { MemoryStore } from '../types';

export interface MemoryToolsOptions {
  /** list_memories 默认返回上限，默认 20 */
  listLimit?: number;
  /** search_memory 默认返回上限，默认 5 */
  searchLimit?: number;
  /** save_memory 保存的记忆 TTL（ms），过期后 prune 时清理 */
  saveTtlMs?: number;
}

/** 工具输入硬上限：防止 LLM 误调用写入超长内容 / 超大集合 */
const MAX_CONTENT_CHARS = 2000;
const MAX_CONCEPTS = 20;
const MAX_LIST_LIMIT = 200;
const MAX_SEARCH_LIMIT = 50;

function clampInt(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : fallback;
  return Math.min(max, Math.max(min, n));
}

export function createMemoryTools(
  store: MemoryStore,
  options: MemoryToolsOptions = {},
): Tool[] {
  const listLimit = clampInt(options.listLimit, 20, 1, MAX_LIST_LIMIT);
  const searchLimit = clampInt(options.searchLimit, 5, 1, MAX_SEARCH_LIMIT);
  const saveTtlMs = options.saveTtlMs;

  const saveMemory: Tool = {
    name: 'save_memory',
    description:
      '保存一条长期记忆（跨会话保留）。用于记录用户偏好、关键决策、事实约束、架构约定等，' +
      '以便后续会话自动检索注入。content 为记忆正文，concepts 为可选关键词标签。',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '记忆正文' },
        concepts: {
          type: 'array',
          items: { type: 'string' },
          description: '可选关键词 / 概念标签',
        },
      },
      required: ['content'],
    },
    async execute(_toolCallId, args): Promise<ToolResult> {
      const a = (args ?? {}) as { content?: string; concepts?: string[] };
      if (!a.content || !a.content.trim()) {
        return {
          content: [createTextContent('save_memory 失败：content 不能为空')],
          details: { error: 'empty content' },
        };
      }
      const content = a.content.trim().slice(0, MAX_CONTENT_CHARS);
      const concepts = (a.concepts ?? [])
        .filter((c): c is string => typeof c === 'string' && c.length > 0)
        .map((c) => c.trim().slice(0, 50))
        .slice(0, MAX_CONCEPTS);
      return store.save({
        content,
        concepts,
        confidence: 0.7,
        source: 'tool',
        ttlMs: saveTtlMs,
      }).then((entry) => ({
        content: [createTextContent(`已保存记忆（id=${entry.id}）`)],
        details: { id: entry.id, saved: true },
      }));
    },
  };

  const searchMemory: Tool = {
    name: 'search_memory',
    description:
      '检索与查询相关的长期记忆（BM25 关键词 + 可选向量混合检索）。返回按相关度排序的记忆列表。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索查询' },
        limit: { type: 'integer', description: '返回上限（默认 5）' },
      },
      required: ['query'],
    },
    async execute(_toolCallId, args): Promise<ToolResult> {
      const a = (args ?? {}) as { query?: string; limit?: number };
      if (!a.query || !a.query.trim()) {
        return {
          content: [createTextContent('search_memory 失败：query 不能为空')],
          details: { error: 'empty query' },
        };
      }
      const limit = clampInt(a.limit, searchLimit, 1, MAX_SEARCH_LIMIT);
      const results = await store.search(a.query.trim(), limit);
      if (results.length === 0) {
        return {
          content: [createTextContent('未找到相关记忆。')],
          details: { count: 0 },
        };
      }
      const lines = results.map(
        (r, i) =>
          `${i + 1}. [score=${r.score.toFixed(2)} id=${r.entry.id}] ${r.entry.content.replace(/\s+/g, ' ').slice(0, 200)}`,
      );
      return {
        content: [createTextContent(`找到 ${results.length} 条相关记忆：\n${lines.join('\n')}`)],
        details: { count: results.length, ids: results.map((r) => r.entry.id) },
      };
    },
  };

  const listMemories: Tool = {
    name: 'list_memories',
    description: '列出最近的长期记忆（按更新时间倒序）。',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: '返回上限（默认 20）' },
      },
    },
    async execute(_toolCallId, args): Promise<ToolResult> {
      const a = (args ?? {}) as { limit?: number };
      const limit = clampInt(a.limit, listLimit, 1, MAX_LIST_LIMIT);
      const entries = await store.list(limit);
      if (entries.length === 0) {
        return {
          content: [createTextContent('当前无任何记忆。')],
          details: { count: 0 },
        };
      }
      const lines = entries.map(
        (e, i) =>
          `${i + 1}. [id=${e.id} conf=${e.confidence.toFixed(2)}] ${e.content.replace(/\s+/g, ' ').slice(0, 200)}`,
      );
      return {
        content: [
          createTextContent(`共 ${entries.length} 条记忆：\n${lines.join('\n')}`),
        ],
        details: { count: entries.length, ids: entries.map((e) => e.id) },
      };
    },
  };

  const deleteMemory: Tool = {
    name: 'delete_memory',
    description: '按 id 删除一条长期记忆。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '记忆 id' },
      },
      required: ['id'],
    },
    async execute(_toolCallId, args): Promise<ToolResult> {
      const a = (args ?? {}) as { id?: string };
      if (!a.id) {
        return {
          content: [createTextContent('delete_memory 失败：id 不能为空')],
          details: { error: 'empty id' },
        };
      }
      const ok = await store.delete(a.id);
      return {
        content: [
          createTextContent(ok ? `已删除记忆（id=${a.id}）` : `未找到记忆（id=${a.id}）`),
        ],
        details: { id: a.id, deleted: ok },
      };
    },
  };

  return [saveMemory, searchMemory, listMemories, deleteMemory];
}
