/**
 * packages/eval/src/core/mock-tools.ts - 标准 mock 工具集
 *
 * 提供一组确定性的内存工具，供 golden 用例构造真实的工作流：
 *   echo      - 回显参数
 *   readFile  - 读 case 预置的内存文件系统
 *   writeFile - 写内存文件系统
 *   listDir   - 列出前缀匹配的文件
 *   search    - 跨文件全文检索
 *   fail      - 恒定失败（测错误恢复轨迹）
 *
 * 工具按 case 隔离：每次 createMockTools 都返回独立 fs 副本。
 */

import type { ContentBlock, Tool, ToolResult } from '@aipack-ai/agent';

const STRING_SCHEMA = {
  type: 'object',
  properties: {
    message: { type: 'string', description: '要回显的消息' },
  },
  required: ['message'],
};

const READ_FILE_SCHEMA = {
  type: 'object',
  properties: {
    path: { type: 'string', description: '文件路径' },
  },
  required: ['path'],
};

const WRITE_FILE_SCHEMA = {
  type: 'object',
  properties: {
    path: { type: 'string', description: '文件路径' },
    content: { type: 'string', description: '写入内容' },
  },
  required: ['path', 'content'],
};

const LIST_DIR_SCHEMA = {
  type: 'object',
  properties: {
    path: { type: 'string', description: '目录前缀' },
  },
};

const SEARCH_SCHEMA = {
  type: 'object',
  properties: {
    query: { type: 'string', description: '检索关键词' },
  },
  required: ['query'],
};

const FAIL_SCHEMA = {
  type: 'object',
  properties: {},
};

function textResult(text: string, details: unknown = null): ToolResult {
  const content: ContentBlock[] = [{ type: 'text', text }];
  return { content, details };
}

function errorResult(message: string): ToolResult {
  const content: ContentBlock[] = [{ type: 'text', text: `error: ${message}` }];
  return { content, details: { error: message } };
}

/** 标准工具名列表（用例 input.tools 缺省时的注册范围） */
export const STANDARD_MOCK_TOOLS = [
  'echo',
  'readFile',
  'writeFile',
  'listDir',
  'search',
  'fail',
] as const;

export type StandardMockToolName = (typeof STANDARD_MOCK_TOOLS)[number];

/**
 * 创建一组隔离的 mock 工具。
 *
 * @param fs 预置文件系统（会被深拷贝，case 间互不影响）
 * @param names 需要的工具名列表；缺省全部标准工具
 */
export function createMockTools(
  fs: Record<string, string> = {},
  names?: string[],
): Tool[] {
  const files: Map<string, string> = new Map(Object.entries(structuredClone(fs)));

  const all: Record<string, Tool> = {
    echo: {
      name: 'echo',
      description: '回显输入消息（测试用）',
      parameters: STRING_SCHEMA,
      execute: async (_id, args) => {
        const message = (args as { message?: unknown })?.message;
        return textResult(String(message ?? ''));
      },
    },
    readFile: {
      name: 'readFile',
      description: '读取内存文件系统中的文件内容',
      parameters: READ_FILE_SCHEMA,
      execute: async (_id, args) => {
        const { path } = (args ?? {}) as { path?: string };
        if (typeof path !== 'string') return errorResult('path 必须为字符串');
        const content = files.get(path);
        if (content === undefined) return errorResult(`文件不存在: ${path}`);
        return textResult(content, { path, bytes: content.length });
      },
    },
    writeFile: {
      name: 'writeFile',
      description: '写入内存文件系统（新建或覆盖）',
      parameters: WRITE_FILE_SCHEMA,
      execute: async (_id, args) => {
        const { path, content } = (args ?? {}) as {
          path?: string;
          content?: string;
        };
        if (typeof path !== 'string' || typeof content !== 'string') {
          return errorResult('path 与 content 必须为字符串');
        }
        files.set(path, content);
        return textResult(`ok: wrote ${content.length} bytes to ${path}`, {
          path,
          bytes: content.length,
        });
      },
    },
    listDir: {
      name: 'listDir',
      description: '列出内存文件系统中指定前缀下的文件',
      parameters: LIST_DIR_SCHEMA,
      execute: async (_id, args) => {
        const { path } = (args ?? {}) as { path?: string };
        const prefix = typeof path === 'string' ? path : '';
        const entries = [...files.keys()]
          .filter((k) => k.startsWith(prefix))
          .sort();
        return textResult(entries.join('\n') || '(empty)', { entries });
      },
    },
    search: {
      name: 'search',
      description: '跨内存文件全文检索，返回 file:line:text 命中行',
      parameters: SEARCH_SCHEMA,
      execute: async (_id, args) => {
        const { query } = (args ?? {}) as { query?: string };
        if (typeof query !== 'string' || query.length === 0) {
          return errorResult('query 必须为非空字符串');
        }
        const hits: string[] = [];
        for (const [file, content] of files) {
          content.split('\n').forEach((line, i) => {
            if (line.includes(query)) hits.push(`${file}:${i + 1}:${line.trim()}`);
          });
        }
        return textResult(hits.join('\n') || '(no matches)', { hits: hits.length });
      },
    },
    fail: {
      name: 'fail',
      description: '恒定返回错误的工具（测错误恢复）',
      parameters: FAIL_SCHEMA,
      execute: async () => errorResult('intentional failure'),
    },
  };

  if (!names || names.length === 0) return [...STANDARD_MOCK_TOOLS].map((n) => all[n]);
  return names.map((n) => all[n]).filter((t): t is Tool => t !== undefined);
}
