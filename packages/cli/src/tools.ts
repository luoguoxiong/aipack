/**
 * 内置工具：read / write / edit / bash
 *
 * 参考 pi 的 coding-agent 默认工具集。每个工具声明 permissions 能力，
 * 供框架级 PermissionPolicy 裁决（如 fs:write → confirm / pending）。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { Tool, ToolResult } from '@aipack-ai/agent';

/** 工作区根目录：文件路径解析的基准（防止越界访问任意路径） */
export const workspaceRoot = process.cwd();

function resolveInWorkspace(p: string): string {
  const abs = path.resolve(workspaceRoot, p);
  if (!abs.startsWith(workspaceRoot)) {
    throw new Error(`路径越界：${p}（工作区：${workspaceRoot}）`);
  }
  return abs;
}

function textResult(text: string, details?: unknown): ToolResult {
  return { content: [{ type: 'text', text }], details: details ?? {} };
}

function errorResult(message: string): ToolResult {
  return {
    content: [{ type: 'text', text: `错误: ${message}` }],
    details: { error: message },
  };
}

/** 单文件读取上限（字符），超出截断 */
const MAX_READ_CHARS = 100_000;

// ─── read ─────────────────────────────────────────────────────────

export const readTool: Tool = {
  name: 'read',
  description: '读取文件内容。返回文本内容，超长自动截断。',
  parameters: {
    type: 'object',
    properties: {
      file: { type: 'string', description: '文件路径（相对工作区）' },
      offset: { type: 'number', description: '起始行号（从 1 开始，可选）' },
      limit: { type: 'number', description: '读取行数（可选）' },
    },
    required: ['file'],
  },
  permissions: ['fs:read'],
  async execute(_id, rawArgs) {
    const args = rawArgs as { file: string; offset?: number; limit?: number };
    try {
      const abs = resolveInWorkspace(args.file);
      let content = await fs.readFile(abs, 'utf8');
      if (args.offset !== undefined || args.limit !== undefined) {
        const lines = content.split('\n');
        const start = Math.max(0, (args.offset ?? 1) - 1);
        const end = args.limit !== undefined ? start + args.limit : lines.length;
        content = lines.slice(start, end).join('\n');
      }
      if (content.length > MAX_READ_CHARS) {
        content = content.slice(0, MAX_READ_CHARS) + `\n...[截断，共 ${content.length} 字符]`;
      }
      return textResult(content, { file: args.file, truncated: content.length >= MAX_READ_CHARS });
    } catch (err) {
      return errorResult(String(err instanceof Error ? err.message : err));
    }
  },
};

// ─── write ────────────────────────────────────────────────────────

export const writeTool: Tool = {
  name: 'write',
  description: '写入文件（创建或覆盖）。自动创建父目录。',
  parameters: {
    type: 'object',
    properties: {
      file: { type: 'string', description: '文件路径（相对工作区）' },
      content: { type: 'string', description: '完整文件内容' },
    },
    required: ['file', 'content'],
  },
  permissions: ['fs:write'],
  async execute(_id, rawArgs) {
    const args = rawArgs as { file: string; content: string };
    try {
      const abs = resolveInWorkspace(args.file);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, args.content, 'utf8');
      return textResult(`已写入 ${args.file}（${args.content.length} 字符）`, { file: args.file });
    } catch (err) {
      return errorResult(String(err instanceof Error ? err.message : err));
    }
  },
};

// ─── edit ─────────────────────────────────────────────────────────

export const editTool: Tool = {
  name: 'edit',
  description: '编辑文件：将 oldString 的首次出现替换为 newString。oldString 必须唯一匹配。',
  parameters: {
    type: 'object',
    properties: {
      file: { type: 'string', description: '文件路径（相对工作区）' },
      oldString: { type: 'string', description: '被替换的文本（须在文件中唯一）' },
      newString: { type: 'string', description: '替换后的文本' },
    },
    required: ['file', 'oldString', 'newString'],
  },
  permissions: ['fs:write'],
  async execute(_id, rawArgs) {
    const args = rawArgs as { file: string; oldString: string; newString: string };
    try {
      const abs = resolveInWorkspace(args.file);
      const content = await fs.readFile(abs, 'utf8');
      const first = content.indexOf(args.oldString);
      if (first === -1) {
        return errorResult(`在 ${args.file} 中未找到 oldString`);
      }
      if (content.indexOf(args.oldString, first + 1) !== -1) {
        return errorResult(`oldString 在 ${args.file} 中出现多次，请提供更长的上下文使其唯一`);
      }
      const updated = content.slice(0, first) + args.newString + content.slice(first + args.oldString.length);
      await fs.writeFile(abs, updated, 'utf8');
      return textResult(`已编辑 ${args.file}`, { file: args.file });
    } catch (err) {
      return errorResult(String(err instanceof Error ? err.message : err));
    }
  },
};

// ─── bash ─────────────────────────────────────────────────────────

function runShell(command: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise(resolve => {
    const child = spawn(command, {
      shell: process.env.SHELL ?? '/bin/bash',
      cwd: workspaceRoot,
      env: { ...process.env, AIPACK_CLI: 'true' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGKILL');
        resolve({ stdout, stderr: stderr + `\n[命令超时（${timeoutMs}ms）被终止]`, code: 124 });
      }
    }, timeoutMs);

    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('close', code => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ stdout, stderr, code: code ?? 0 });
      }
    });
    child.on('error', err => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ stdout, stderr: String(err), code: -1 });
      }
    });
  });
}

export const bashTool: Tool = {
  name: 'bash',
  description: '在工作区执行 shell 块命令并返回输出。适用于文件搜索、构建、测试等操作。',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的命令' },
      timeoutMs: { type: 'number', description: '超时毫秒数（默认 60000）' },
    },
    required: ['command'],
  },
  permissions: ['shell:exec'],
  async execute(_id, rawArgs) {
    const args = rawArgs as { command: string; timeoutMs?: number };
    const timeout = args.timeoutMs ?? 60_000;
    try {
      const { stdout, stderr, code } = await runShell(args.command, timeout);
      const parts: string[] = [];
      if (stdout.trim()) parts.push(`[stdout]\n${stdout.slice(0, MAX_READ_CHARS)}`);
      if (stderr.trim()) parts.push(`[stderr]\n${stderr.slice(0, MAX_READ_CHARS)}`);
      parts.push(`[退出码 ${code}]`);
      return textResult(parts.join('\n'), { command: args.command, code });
    } catch (err) {
      return errorResult(String(err instanceof Error ? err.message : err));
    }
  },
};

// ─── 工具集组装 ───────────────────────────────────────────────────

export const BUILTIN_TOOLS: Tool[] = [readTool, writeTool, editTool, bashTool];

/**
 * 按白名单/黑名单过滤内置工具。
 * - tools: 仅保留白名单中的工具
 * - excludeTools: 移除黑名单中的工具
 * - noTools: 返回空数组
 */
export function selectTools(options: {
  tools?: string[];
  excludeTools?: string[];
  noTools?: boolean;
}): Tool[] {
  if (options.noTools) return [];
  let selected = [...BUILTIN_TOOLS];
  if (options.tools && options.tools.length > 0) {
    const allow = new Set(options.tools);
    selected = selected.filter(t => allow.has(t.name));
  }
  if (options.excludeTools && options.excludeTools.length > 0) {
    const deny = new Set(options.excludeTools);
    selected = selected.filter(t => !deny.has(t.name));
  }
  return selected;
}
