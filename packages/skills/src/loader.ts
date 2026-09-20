/**
 * Skills - 文件加载器（Node only）
 *
 * 发现规则（对齐 Agent Skills 开放规范 / pi）：
 *   - 目录含 SKILL.md → 视为 skill 根，不再递归；name 缺省取目录名
 *   - 否则扫描根下直接 .md 子文件；再递归子目录寻找 SKILL.md
 *   - 跳过 '.' 开头目录与 node_modules
 * 多源优先级：user → project → extraPaths，同名先注册者胜，败者产出 collision 诊断。
 * 加载失败 / 校验失败只产诊断不中断（健壮性优先）。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { Skill, SkillDiagnostic, LoadSkillsOptions } from './types';
import { validateSkill } from './core';

// ─── frontmatter 解析（手写 YAML-lite，零新依赖）──────────────────

export interface ParseSkillMarkdownOptions {
  /** frontmatter name 缺省时的回退名（目录名 / 文件名） */
  fallbackName?: string;
  /** 来源文件路径（填入 skill.filePath，baseDir 取 dirname） */
  filePath?: string;
  /** 来源标识（诊断用） */
  source?: string;
}

/**
 * 解析 SKILL.md 文本为 Skill。
 * frontmatter 支持顶层 key: value（name / description / disable-model-invocation），
 * 值可带单双引号；其余 key 忽略。缺失 name 用 fallbackName；缺失 description 报错。
 */
export function parseSkillMarkdown(
  text: string,
  options: ParseSkillMarkdownOptions = {},
): { skill?: Skill; errors: string[] } {
  const errors: string[] = [];
  const normalized = text.replace(/^\uFEFF/, '');
  const lines = normalized.split(/\r?\n/);

  const frontmatter = extractFrontmatter(lines);
  const content = frontmatter ? frontmatter.rest.join('\n').trim() : normalized.trim();

  const name = frontmatter?.fields.get('name') ?? options.fallbackName;
  const description = frontmatter?.fields.get('description');
  const disableRaw = frontmatter?.fields.get('disable-model-invocation');

  if (!name) errors.push('name 缺失（frontmatter 或目录名均未提供）');
  if (!description) errors.push('description 缺失（frontmatter）');

  const skill: Skill = {
    name: name ?? '',
    description: description ?? '',
    content,
    disableModelInvocation: disableRaw === 'true',
    source: options.source ?? 'path',
  };
  if (options.filePath) {
    skill.filePath = options.filePath;
    skill.baseDir = dirnameOf(options.filePath);
  }

  // 无论是否有错误都返回 skill：调用方以 errors 为准决定是否注册，
  // 同时保留字段供上层诊断展示
  return { skill, errors };
}

/** 提取文件顶部 --- 包裹的 frontmatter；无则返回 null */
function extractFrontmatter(lines: string[]): { fields: Map<string, string>; rest: string[] } | null {
  if ((lines[0] ?? '').trim() !== '---') return null;
  const fields = new Map<string, string>();
  let i = 1;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '---') break;
    const idx = line.indexOf(':');
    if (idx <= 0) continue; // 忽略非 key: value 行（嵌套结构不支持）
    const key = line.slice(0, idx).trim();
    const value = stripQuotes(line.slice(idx + 1).trim());
    if (key) fields.set(key, value);
  }
  // 未闭合（无结束 ---）：视为无 frontmatter 的普通文档
  if (i >= lines.length) return null;
  return { fields, rest: lines.slice(i + 1) };
}

function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    if ((first === '"' || first === "'") && value[value.length - 1] === first) {
      return value.slice(1, -1);
    }
  }
  return value;
}

function dirnameOf(filePath: string): string {
  const idx = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  return idx > 0 ? filePath.slice(0, idx) : filePath;
}

// ─── 目录扫描 ──────────────────────────────────────────────────────

/** 目录内收集 skill（SKILL.md 根不递归；否则扫 .md 文件 + 递归子目录） */
function collectFromDir(
  dir: string,
  source: string,
  diagnostics: SkillDiagnostic[],
): Skill[] {
  const skillMdPath = join(dir, 'SKILL.md');
  if (existsSync(skillMdPath)) {
    const { skill, errors } = parseSkillMarkdown(
      readText(skillMdPath),
      { fallbackName: basename(dir), filePath: skillMdPath, source },
    );
    if (skill) return [skill];
    diagnostics.push({ type: 'error', message: errors.join('; '), path: skillMdPath });
    return [];
  }

  const skills: Skill[] = [];
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    diagnostics.push({
      type: 'warning',
      message: `目录读取失败: ${(err as Error)?.message ?? err}`,
      path: dir,
    });
    return [];
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      skills.push(...collectFromDir(full, source, diagnostics));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md') && entry.name !== 'SKILL.md') {
      const { skill, errors } = parseSkillMarkdown(
        readText(full),
        { fallbackName: basename(entry.name, '.md'), filePath: full, source },
      );
      if (skill) skills.push(skill);
      else diagnostics.push({ type: 'error', message: errors.join('; '), path: full });
    }
  }
  return skills;
}

function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

// ─── 多源加载 ──────────────────────────────────────────────────────

/**
 * 加载 skills：user → project → extraPaths，同名先注册者胜（user 优先）。
 * 缺省来源：userDir = ~/.aipack/skills，project = <cwd>/.aipack/skills。
 * 目录不存在静默跳过；校验失败 / 同名冲突产出诊断，不中断。
 */
export function loadSkills(
  options: LoadSkillsOptions = {},
): { skills: Skill[]; diagnostics: SkillDiagnostic[] } {
  const cwd = options.cwd ?? process.cwd();
  const diagnostics: SkillDiagnostic[] = [];
  const byName = new Map<string, Skill>();
  const skills: Skill[] = [];

  const register = (skill: Skill | undefined, path: string): void => {
    if (!skill) return;
    const errors = validateSkill(skill);
    if (errors.length > 0) {
      diagnostics.push({ type: 'error', message: errors.join('; '), path });
      return;
    }
    const existing = byName.get(skill.name);
    if (existing) {
      diagnostics.push({
        type: 'collision',
        message: `skill "${skill.name}" 已注册（${existing.filePath ?? 'inline'}），忽略后注册者`,
        path,
      });
      return;
    }
    byName.set(skill.name, skill);
    skills.push(skill);
  };

  const loadDir = (dir: string, source: string): void => {
    if (!dir || !existsSync(dir)) return;
    for (const skill of collectFromDir(dir, source, diagnostics)) {
      register(skill, skill.filePath ?? dir);
    }
  };
  const loadFile = (file: string, source: string): void => {
    if (!file || !existsSync(file)) return;
    const { skill, errors } = parseSkillMarkdown(readText(file), {
      fallbackName: basename(file, '.md'),
      filePath: file,
      source,
    });
    register(skill, file);
    if (errors.length > 0) {
      diagnostics.push({ type: 'error', message: errors.join('; '), path: file });
    }
  };

  // 多源优先级：user → project → extraPaths。
  // includeDefaults=false 仅跳过"默认目录"；显式指定的 userDir / projectDirName 仍生效。
  const userDir = options.userDir ?? join(homedir(), '.aipack', 'skills');
  const projectDir = join(cwd, options.projectDirName ?? join('.aipack', 'skills'));
  if (options.includeDefaults !== false) {
    loadDir(userDir, 'user');
    loadDir(projectDir, 'project');
  } else {
    if (options.userDir) loadDir(userDir, 'user');
    if (options.projectDirName) loadDir(projectDir, 'project');
  }

  for (const p of options.extraPaths ?? []) {
    if (!p || !existsSync(p)) {
      diagnostics.push({ type: 'warning', message: `extraPath 不存在，已跳过`, path: p });
      continue;
    }
    let isDir = false;
    try {
      isDir = statSync(p).isDirectory();
    } catch {
      isDir = false;
    }
    if (isDir) loadDir(p, 'path');
    else loadFile(p, 'path');
  }

  return { skills, diagnostics };
}
