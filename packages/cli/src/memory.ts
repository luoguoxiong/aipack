/**
 * 项目记忆文件（CLAUDE.md 类）加载与注入
 *
 * - 用户级：~/.aipack/AIPACK.md（个人偏好，跨项目）
 * - 项目级：cwd 下按优先级取第一个存在的 AIPACK.md > AGENTS.md > CLAUDE.md
 *   （AGENTS.md / CLAUDE.md 兼容既有生态，零迁移成本）
 * - 支持 `@path` 行级导入（相对被导入文件所在目录），深度限制 5 层、循环去重
 * - 内容注入 system prompt 尾部；无任何记忆文件时零改动（向后兼容）
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** 项目级记忆文件优先级（取第一个存在的） */
export const PROJECT_MEMORY_FILES = ['AIPACK.md', 'AGENTS.md', 'CLAUDE.md'] as const;

const MAX_IMPORT_DEPTH = 5;

export interface LoadedMemory {
  /** 已加载的记忆文件（含导入展开，按加载顺序） */
  files: string[];
  /** 拼接后的完整内容（空字符串 = 无记忆） */
  content: string;
}

interface LoadState {
  files: string[];
  visited: Set<string>;
}

/**
 * 加载用户级 + 项目级记忆文件（@import 递归展开）。
 * 单文件读取失败静默跳过（记忆是辅助信息，不阻塞启动）。
 */
export async function loadMemoryFiles(cwd: string): Promise<LoadedMemory> {
  const state: LoadState = { files: [], visited: new Set() };
  const parts: string[] = [];

  const userFile = path.join(os.homedir(), '.aipack', 'AIPACK.md');
  const projectFile = await findProjectMemoryFile(cwd);
  const sources: Array<{ file: string; label: 'user' | 'project' }> = [
    { file: userFile, label: 'user' as const },
    ...(projectFile ? [{ file: projectFile, label: 'project' as const }] : []),
  ];

  for (const { file, label } of sources) {
    const text = await readMemoryTree(file, 0, state);
    if (text.trim()) {
      parts.push(renderMemorySection(text, file, label));
    }
  }

  return { files: state.files, content: parts.join('\n\n') };
}

/** 项目根下按优先级找第一个存在的记忆文件；无则 undefined */
export async function findProjectMemoryFile(cwd: string): Promise<string | undefined> {
  for (const name of PROJECT_MEMORY_FILES) {
    const full = path.join(cwd, name);
    try {
      const stat = await fs.stat(full);
      if (stat.isFile()) return full;
    } catch {
      // 不存在 → 尝试下一个
    }
  }
  return undefined;
}

/** 渲染单段记忆（标注来源，模型可感知作用域） */
function renderMemorySection(text: string, file: string, label: 'user' | 'project'): string {
  const scope = label === 'user' ? '用户级（个人偏好，适用于所有项目）' : '项目级（团队共享的项目约定）';
  return `<memory source="${file}" scope="${scope}">\n${text.trim()}\n</memory>`;
}

/** 读取记忆文件并展开 @import（行级：trim 后以 @ 开头） */
async function readMemoryTree(file: string, depth: number, state: LoadState): Promise<string> {
  if (depth > MAX_IMPORT_DEPTH) {
    console.warn(`[aipack] 记忆文件 @import 超过最大深度 ${MAX_IMPORT_DEPTH}，已停止展开: ${file}`);
    return '';
  }
  const resolved = path.resolve(file);
  if (state.visited.has(resolved)) return ''; // 循环导入去重
  state.visited.add(resolved);

  let text: string;
  try {
    text = await fs.readFile(resolved, 'utf8');
  } catch {
    return '';
  }
  state.files.push(resolved);

  const lines = text.split('\n');
  const out: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('@') && trimmed.length > 1 && !trimmed.includes(' ')) {
      const ref = trimmed.slice(1);
      const target = path.isAbsolute(ref) ? ref : path.join(path.dirname(resolved), ref);
      const imported = await readMemoryTree(target, depth + 1, state);
      if (imported.trim()) out.push(imported);
    } else {
      out.push(line);
    }
  }
  return out.join('\n');
}

/** /init 命令的生成提示词：让模型扫描项目并写入 AIPACK.md（复用 agentic 循环 + write 工具） */
export const INIT_COMMAND_PROMPT = [
  '请为当前项目创建项目记忆文件 AIPACK.md（工作区根目录）。步骤：',
  '1. 快速了解项目：读 package.json / README / 目录结构，识别技术栈、构建与测试命令、目录组织；',
  '2. 写入 AIPACK.md，内容精炼（一般不超过 50 行），包含：',
  '   - 项目一句话说明与技术栈；',
  '   - 常用命令（安装 / 构建 / 测试 / lint）；',
  '   - 代码风格与架构约定（从现有代码归纳，不要臆造）；',
  '   - 其余对本项目重要的注意事项。',
  '3. 用 write 工具写入 AIPACK.md 后，简要汇报写入的章节。',
  '注意：仅创建/覆盖 AIPACK.md 本身，不要改动其他文件。',
].join('\n');
