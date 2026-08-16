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

// ─── 文件检索辅助 ─────────────────────────────────────────────────

/** 遍历时剪枝的目录（依赖产物与版本控制元数据） */
const PRUNED_DIRS = new Set(['node_modules', '.git', 'dist', '.next', '.turbo', 'coverage']);

/** 单文件读取上限（grep 用，跳过超大文件） */
const MAX_GREP_FILE_BYTES = 2 * 1024 * 1024;

/** glob → RegExp：支持 **（跨目录）、*（单段）、?（单字符） */
function globToRegExp(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*';
        i++;
        if (pattern[i + 1] === '/') i++; // "**/" 吞掉分隔符
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

/** 递归遍历目录，返回相对搜索根的 posix 路径（剪枝 PRUNED_DIRS） */
async function walkFiles(root: string, maxEntries: number): Promise<string[]> {
  const out: string[] = [];
  const queue: string[] = [''];
  while (queue.length > 0 && out.length < maxEntries) {
    const rel = queue.shift()!;
    const abs = path.join(root, rel);
    let entries;
    try {
      entries = await fs.readdir(abs, { withFileTypes: true });
    } catch {
      continue; // 无权限等 → 跳过
    }
    for (const e of entries) {
      if (out.length >= maxEntries) break;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!PRUNED_DIRS.has(e.name)) queue.push(childRel);
      } else if (e.isFile()) {
        out.push(childRel);
      }
    }
  }
  return out;
}

// ─── find ─────────────────────────────────────────────────────────

export const findTool: Tool = {
  name: 'find',
  description: '按 glob 模式查找文件。支持 ** 跨目录匹配。示例: "**/*.ts"、"src/**/*.spec.ts"',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'glob 模式，如 "*.md" 或 "**/*.ts"' },
      path: { type: 'string', description: '搜索目录（相对工作区，默认 .）' },
      limit: { type: 'number', description: '最大结果数（默认 1000）' },
    },
    required: ['pattern'],
  },
  permissions: ['fs:read'],
  async execute(_id, rawArgs) {
    const args = rawArgs as { pattern: string; path?: string; limit?: number };
    const limit = args.limit ?? 1000;
    try {
      const root = resolveInWorkspace(args.path ?? '.');
      const re = globToRegExp(args.pattern);
      // 遍历上限与结果上限解耦：遍历足够多文件后再过滤，避免低匹配率时提前截断
      const files = await walkFiles(root, Math.max(limit * 10, 10_000));
      const matches = files.filter(f => re.test(f));
      const limited = matches.slice(0, limit);
      if (limited.length === 0) {
        return textResult(`未找到匹配 "${args.pattern}" 的文件`, { pattern: args.pattern });
      }
      const suffix = matches.length > limited.length ? `\n...[共 ${matches.length} 个，已截断至 ${limit}]` : '';
      return textResult(`${limited.join('\n')}${suffix}`, {
        pattern: args.pattern,
        count: matches.length,
        truncated: matches.length > limited.length,
      });
    } catch (err) {
      return errorResult(String(err instanceof Error ? err.message : err));
    }
  },
};

// ─── grep ─────────────────────────────────────────────────────────

export const grepTool: Tool = {
  name: 'grep',
  description: '在文件内容中搜索模式（默认正则）。自动跳过二进制/超大文件与 node_modules。输出 file:line: text',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '搜索模式（正则，或配合 literal 使用字面量）' },
      path: { type: 'string', description: '搜索的目录或文件（相对工作区，默认 .）' },
      glob: { type: 'string', description: '文件名过滤 glob，如 "*.ts"' },
      ignoreCase: { type: 'boolean', description: '忽略大小写（默认 false）' },
      literal: { type: 'boolean', description: '按字面量而非正则解释 pattern（默认 false）' },
      context: { type: 'number', description: '每个匹配前后显示的行数（默认 0）' },
      limit: { type: 'number', description: '最大匹配数（默认 100）' },
    },
    required: ['pattern'],
  },
  permissions: ['fs:read'],
  async execute(_id, rawArgs) {
    const args = rawArgs as {
      pattern: string; path?: string; glob?: string;
      ignoreCase?: boolean; literal?: boolean; context?: number; limit?: number;
    };
    const limit = args.limit ?? 100;
    const context = args.context ?? 0;
    try {
      const target = resolveInWorkspace(args.path ?? '.');
      const re = new RegExp(
        args.literal ? args.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : args.pattern,
        args.ignoreCase ? 'i' : '',
      );
      const globRe = args.glob ? globToRegExp(args.glob) : undefined;

      // 确定待搜文件清单（相对工作区）
      let files: Array<{ rel: string; abs: string }>;
      const stat = await fs.stat(target);
      if (stat.isFile()) {
        files = [{ rel: path.relative(workspaceRoot, target), abs: target }];
      } else if (stat.isDirectory()) {
        files = (await walkFiles(target, 20_000))
          .filter(f => !globRe || globRe.test(f) || globRe.test(f.split('/').pop()!))
          .map(f => ({ rel: f, abs: path.join(target, f) }));
      } else {
        return errorResult(`不是文件或目录: ${args.path}`);
      }

      const out: string[] = [];
      let matchCount = 0;
      let truncated = false;

      for (const file of files) {
        if (matchCount >= limit) { truncated = true; break; }
        let buf: Buffer;
        try {
          const st = await fs.stat(file.abs);
          if (st.size > MAX_GREP_FILE_BYTES) continue;
          buf = await fs.readFile(file.abs);
        } catch {
          continue;
        }
        if (buf.includes(0)) continue; // 二进制文件
        const lines = buf.toString('utf8').split('\n');

        // 收集本文件匹配行号
        const hitLines: number[] = [];
        for (let i = 0; i < lines.length && matchCount + hitLines.length < limit; i++) {
          if (re.test(lines[i])) hitLines.push(i);
        }
        if (hitLines.length === 0) continue;
        matchCount += hitLines.length;

        // 带去重的行号区间（context 展开）
        const show = new Set<number>();
        for (const h of hitLines) {
          for (let i = Math.max(0, h - context); i <= Math.min(lines.length - 1, h + context); i++) {
            show.add(i);
          }
        }
        for (const i of [...show].sort((a, b) => a - b)) {
          const marker = hitLines.includes(i) ? '>' : ' ';
          out.push(`${file.rel}:${i + 1}:${marker} ${lines[i].slice(0, 500)}`);
        }
      }

      if (out.length === 0) {
        return textResult(`未找到匹配 "${args.pattern}" 的内容`, { pattern: args.pattern, count: 0 });
      }
      const suffix = truncated ? `\n...[已达 ${limit} 个匹配上限，截断]` : '';
      return textResult(`${out.join('\n')}${suffix}`, {
        pattern: args.pattern,
        count: matchCount,
        truncated,
      });
    } catch (err) {
      return errorResult(String(err instanceof Error ? err.message : err));
    }
  },
};

// ─── ls ───────────────────────────────────────────────────────────

export const lsTool: Tool = {
  name: 'ls',
  description: '列出目录内容（目录带 / 后缀，目录在前）。探索项目结构时优先使用。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '目录路径（相对工作区，默认 .）' },
      limit: { type: 'number', description: '最大条目数（默认 500）' },
    },
  },
  permissions: ['fs:read'],
  async execute(_id, rawArgs) {
    const args = rawArgs as { path?: string; limit?: number };
    const limit = args.limit ?? 500;
    try {
      const abs = resolveInWorkspace(args.path ?? '.');
      const stat = await fs.stat(abs);
      if (!stat.isDirectory()) {
        return textResult(path.relative(workspaceRoot, abs) || abs);
      }
      const entries = await fs.readdir(abs, { withFileTypes: true });
      const sorted = entries
        .filter(e => e.isDirectory() || e.isFile() || e.isSymbolicLink())
        .sort((a, b) => {
          const ad = a.isDirectory() ? 0 : 1;
          const bd = b.isDirectory() ? 0 : 1;
          return ad !== bd ? ad - bd : a.name.localeCompare(b.name);
        });
      const limited = sorted.slice(0, limit);
      if (limited.length === 0) {
        return textResult('（空目录）', {});
      }
      const lines = limited.map(e =>
        e.isDirectory() ? `${e.name}/` : e.isSymbolicLink() ? `${e.name}@` : e.name,
      );
      const suffix = sorted.length > limited.length ? `\n...[共 ${sorted.length} 项，已截断至 ${limit}]` : '';
      return textResult(`${lines.join('\n')}${suffix}`, {
        path: args.path ?? '.',
        count: sorted.length,
        truncated: sorted.length > limited.length,
      });
    } catch (err) {
      return errorResult(String(err instanceof Error ? err.message : err));
    }
  },
};

// ─── 工具集组装 ───────────────────────────────────────────────────

export const BUILTIN_TOOLS: Tool[] = [readTool, writeTool, editTool, bashTool, findTool, grepTool, lsTool];

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
