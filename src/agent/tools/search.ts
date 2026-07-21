import { BaseTool, ToolContext, ToolResult, createToolResult, createToolError } from './base.js';
import { z } from 'zod';
import fs from 'fs/promises';
import path from 'path';

const _DEFAULT_HEAD_LIMIT = 250;
const _DEFAULT_FILE_HEAD_LIMIT = 200;
const _MAX_RESULT_CHARS = 128_000;
const _MAX_FILE_BYTES = 2_000_000;

const _TYPE_GLOB_MAP: Record<string, string[]> = {
  py: ['*.py', '*.pyi'],
  python: ['*.py', '*.pyi'],
  js: ['*.js', '*.jsx', '*.mjs', '*.cjs'],
  ts: ['*.ts', '*.tsx', '*.mts', '*.cts'],
  tsx: ['*.tsx'],
  jsx: ['*.jsx'],
  json: ['*.json'],
  md: ['*.md', '*.mdx'],
  markdown: ['*.md', '*.mdx'],
  go: ['*.go'],
  rs: ['*.rs'],
  rust: ['*.rs'],
  java: ['*.java'],
  sh: ['*.sh', '*.bash'],
  yaml: ['*.yaml', '*.yml'],
  yml: ['*.yaml', '*.yml'],
  toml: ['*.toml'],
  sql: ['*.sql'],
  html: ['*.html', '*.htm'],
  css: ['*.css', '*.scss', '*.sass'],
};

const _IGNORE_DIRS = new Set([
  '.git', '.hg', '.svn', '__pycache__', '.pytest_cache', '.mypy_cache',
  'node_modules', '.next', '.nuxt', 'dist', 'build', '.venv', 'venv',
  '.idea', '.vscode', '.tox', 'target', '.cargo', '.gradle', 'vendor',
]);

const FindFilesSchema = z.object({
  path: z.string().optional().describe('Directory or file to search in (default \'.\')'),
  query: z.string().optional().describe(
    'Optional case-insensitive path fragment search. ' +
    'Whitespace-separated terms must all be present.',
  ),
  glob: z.string().optional().describe(
    'Optional file filter, e.g. \'*.py\' or \'tests/**/test_*.py\'',
  ),
  type: z.string().optional().describe(
    'Optional file type shorthand, e.g. \'py\', \'ts\', \'md\', \'json\'',
  ),
  include_dirs: z.boolean().optional().describe(
    'Include matching directories as well as files (default false)',
  ),
  sort: z.enum(['path', 'modified']).optional().describe(
    'Sort by path or most recently modified first (default path)',
  ),
  head_limit: z.number().int().min(0).max(1000).optional().describe(
    'Maximum number of paths to return (default 200, 0 for all, max 1000)',
  ),
  offset: z.number().int().min(0).max(100000).optional().describe(
    'Skip the first N results before applying head_limit',
  ),
});

const GrepSchema = z.object({
  pattern: z.string().min(1).describe('Regex or plain text pattern to search for'),
  path: z.string().optional().describe('File or directory to search in (default \'.\')'),
  glob: z.string().optional().describe(
    'Optional file filter, e.g. \'*.py\' or \'tests/**/test_*.py\'',
  ),
  type: z.string().optional().describe(
    'Optional file type shorthand, e.g. \'py\', \'ts\', \'md\', \'json\'',
  ),
  case_insensitive: z.boolean().optional().describe(
    'Case-insensitive search (default false)',
  ),
  fixed_strings: z.boolean().optional().describe(
    'Treat pattern as plain text instead of regex (default false)',
  ),
  output_mode: z.enum(['content', 'files_with_matches', 'count']).optional().describe(
    'content: matching lines with optional context; ' +
    'files_with_matches: only matching file paths; ' +
    'count: matching line counts per file. ' +
    'Default: files_with_matches',
  ),
  context_before: z.number().int().min(0).max(20).optional().describe(
    'Number of lines of context before each match',
  ),
  context_after: z.number().int().min(0).max(20).optional().describe(
    'Number of lines of context after each match',
  ),
  max_matches: z.number().int().min(1).max(1000).optional().describe(
    'Legacy alias for head_limit in content mode',
  ),
  max_results: z.number().int().min(1).max(1000).optional().describe(
    'Legacy alias for head_limit in files_with_matches or count mode',
  ),
  head_limit: z.number().int().min(0).max(1000).optional().describe(
    'Maximum number of results to return. In content mode this limits ' +
    'matching line blocks; in other modes it limits file entries. ' +
    'Default 250',
  ),
  offset: z.number().int().min(0).max(100000).optional().describe(
    'Skip the first N results before applying head_limit',
  ),
});

function _normalizePattern(pattern: string): string {
  return pattern.trim().replace(/\\/g, '/');
}

function _matchGlob(relPath: string, name: string, pattern: string): boolean {
  const normalized = _normalizePattern(pattern);
  if (!normalized) return false;
  if (normalized.includes('/') || normalized.startsWith('**')) {
    const rel = relPath.split(path.sep).join('/');
    return _minimatch(rel, normalized);
  }
  return _fnmatch(name.toLowerCase(), normalized.toLowerCase());
}

function _fnmatch(name: string, pattern: string): boolean {
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  const regex = new RegExp(`^${regexStr}$`);
  return regex.test(name);
}

function _minimatch(relPath: string, pattern: string): boolean {
  const patternParts = pattern.split('/');
  const pathParts = relPath.split('/');
  return _matchGlobParts(pathParts, patternParts, 0, 0);
}

function _matchGlobParts(pathParts: string[], patternParts: string[], pi: number, pj: number): boolean {
  while (pj < patternParts.length) {
    const part = patternParts[pj];
    if (part === '**') {
      if (pj === patternParts.length - 1) return true;
      for (let i = pi; i <= pathParts.length; i++) {
        if (_matchGlobParts(pathParts, patternParts, i, pj + 1)) return true;
      }
      return false;
    }
    if (pi >= pathParts.length) return false;
    if (!_fnmatch(pathParts[pi], part)) return false;
    pi++;
    pj++;
  }
  return pi === pathParts.length;
}

function _isBinary(raw: Buffer): boolean {
  if (raw.includes(Buffer.from([0]))) return true;
  const sample = raw.slice(0, 4096);
  if (sample.length === 0) return false;
  let nonText = 0;
  for (let i = 0; i < sample.length; i++) {
    const b = sample[i];
    if (b < 9 || (b > 13 && b < 32)) nonText++;
  }
  return nonText / sample.length > 0.2;
}

function _paginate<T>(items: T[], limit: number | null, offset: number): [T[], boolean] {
  if (limit === null) return [items.slice(offset), false];
  const sliced = items.slice(offset, offset + limit);
  const truncated = items.length > offset + limit;
  return [sliced, truncated];
}

function _paginationNote(limit: number | null, offset: number, truncated: boolean): string | null {
  if (truncated) {
    if (limit === null) return `(pagination: offset=${offset})`;
    return `(pagination: limit=${limit}, offset=${offset})`;
  }
  if (offset > 0) return `(pagination: offset=${offset})`;
  return null;
}

function _matchesType(name: string, fileType: string | undefined): boolean {
  if (!fileType) return true;
  const lowered = fileType.trim().toLowerCase();
  if (!lowered) return true;
  const patterns = _TYPE_GLOB_MAP[lowered] || [`*.${lowered}`];
  return patterns.some(p => _fnmatch(name.toLowerCase(), p.toLowerCase()));
}

function _matchesQuery(displayPath: string, query: string | undefined): boolean {
  if (!query) return true;
  const haystack = displayPath.toLowerCase();
  const terms = query.toLowerCase().split(/\s+/).filter(t => t);
  return terms.every(term => haystack.includes(term));
}

abstract class _SearchTool extends BaseTool {
  protected _resolve(p: string, workspace?: string): string {
    if (path.isAbsolute(p)) return p;
    const base = workspace || process.cwd();
    return path.resolve(base, p);
  }

  protected _displayPath(target: string, root: string, workspace?: string): string {
    const ws = workspace;
    if (ws) {
      try {
        return path.relative(ws, target).split(path.sep).join('/');
      } catch {
        // ignore
      }
    }
    return path.relative(root, target).split(path.sep).join('/');
  }

  protected async _iterFiles(root: string): Promise<string[]> {
    const results: string[] = [];
    const rootStat = await fs.stat(root).catch(() => null);
    if (!rootStat) return results;
    if (rootStat.isFile()) {
      results.push(root);
      return results;
    }
    await this._walkDir(root, results);
    return results;
  }

  private async _walkDir(dir: string, results: string[]): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    const dirs: string[] = [];
    const files: string[] = [];
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!_IGNORE_DIRS.has(entry.name)) {
          dirs.push(entry.name);
        }
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
    dirs.sort();
    files.sort();
    results.push(...files);
    for (const d of dirs) {
      await this._walkDir(path.join(dir, d), results);
    }
  }

  protected async _iterPaths(target: string, includeDirs: boolean): Promise<string[]> {
    const results: string[] = [];
    const stat = await fs.stat(target).catch(() => null);
    if (!stat) return results;
    if (stat.isFile()) {
      results.push(target);
      return results;
    }
    await this._walkDirWithDirs(target, results, includeDirs, target);
    return results;
  }

  private async _walkDirWithDirs(
    dir: string, results: string[], includeDirs: boolean, root: string,
  ): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    const dirs: string[] = [];
    const files: string[] = [];
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!_IGNORE_DIRS.has(entry.name)) {
          dirs.push(entry.name);
          if (includeDirs && fullPath !== root) {
            results.push(fullPath);
          }
        }
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
    dirs.sort();
    files.sort();
    results.push(...files);
    for (const d of dirs) {
      await this._walkDirWithDirs(path.join(dir, d), results, includeDirs, root);
    }
  }
}

export class FindFilesTool extends _SearchTool {
  name = 'find_files';
  description = (
    'Find files by path fragment, glob, or file type. ' +
    'Use this before read_file when you need to locate files, and ' +
    'prefer it over shell find/ls for ordinary workspace discovery. ' +
    'Returns workspace-relative paths and skips common dependency/build ' +
    'directories.'
  );
  input_schema = FindFilesSchema;
  tags = ['search', 'filesystem', 'read'];

  async execute(args: unknown, context: ToolContext): Promise<ToolResult> {
    try {
      const params = this.input_schema.parse(args);
      const target = this._resolve(params.path || '.', context.workspace);
      const targetStat = await fs.stat(target).catch(() => null);
      if (!targetStat) {
        return createToolError(`Error: Path not found: ${params.path || '.'}`);
      }
      if (!targetStat.isDirectory() && !targetStat.isFile()) {
        return createToolError(`Error: Unsupported path: ${params.path || '.'}`);
      }

      const sort = params.sort || 'path';
      const headLimit = params.head_limit;
      const limit = (
        headLimit === undefined
          ? _DEFAULT_FILE_HEAD_LIMIT
          : headLimit === 0 ? null : headLimit
      );
      const offset = params.offset || 0;
      const root = targetStat.isDirectory() ? target : path.dirname(target);
      const matches: Array<[string, number]> = [];

      const candidates = await this._iterPaths(target, params.include_dirs || false);
      for (const candidate of candidates) {
        const candidateStat = await fs.stat(candidate).catch(() => null);
        if (!candidateStat) continue;
        if (candidateStat.isDirectory() && !params.include_dirs) continue;

        const relPath = path.relative(root, candidate).split(path.sep).join('/');
        const displayPath = this._displayPath(candidate, root, context.workspace);
        const name = path.basename(candidate);

        if (params.glob && !_matchGlob(relPath, name, params.glob)) continue;
        if (candidateStat.isFile() && !_matchesType(name, params.type)) continue;
        if (candidateStat.isDirectory() && params.type) continue;
        if (!_matchesQuery(displayPath, params.query)) continue;

        const mtime = candidateStat.mtimeMs;
        const suffix = candidateStat.isDirectory() ? '/' : '';
        matches.push([displayPath + suffix, mtime]);
      }

      if (sort === 'modified') {
        matches.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      } else {
        matches.sort((a, b) => a[0].localeCompare(b[0]));
      }

      const paths = matches.map(item => item[0]);
      const [paged, truncated] = _paginate(paths, limit, offset);
      if (paged.length === 0) {
        return createToolResult('No files found');
      }

      let result = paged.join('\n');
      const note = _paginationNote(limit, offset, truncated);
      if (note) {
        result += '\n\n' + note;
      }
      return createToolResult(result);
    } catch (err) {
      if ((err as Error).message.includes('permission')) {
        return createToolError(`Error: ${(err as Error).message}`);
      }
      return createToolError(`Error finding files: ${(err as Error).message}`);
    }
  }
}

export class GrepTool extends _SearchTool {
  name = 'grep';
  description = (
    'Search file contents with a regex pattern. ' +
    'Default output_mode is files_with_matches (file paths only); ' +
    'use content mode for matching lines with context. Prefer this ' +
    'over shell grep for ordinary workspace searches. ' +
    'Skips binary and files >2 MB. Supports glob/type filtering.'
  );
  input_schema = GrepSchema;
  tags = ['search', 'filesystem', 'read'];

  private _formatBlock(
    displayPath: string,
    lines: string[],
    matchLine: number,
    before: number,
    after: number,
  ): string {
    const start = Math.max(1, matchLine - before);
    const end = Math.min(lines.length, matchLine + after);
    const block: string[] = [`${displayPath}:${matchLine}`];
    for (let lineNo = start; lineNo <= end; lineNo++) {
      const marker = lineNo === matchLine ? '>' : ' ';
      block.push(`${marker} ${lineNo}| ${lines[lineNo - 1]}`);
    }
    return block.join('\n');
  }

  async execute(args: unknown, context: ToolContext): Promise<ToolResult> {
    try {
      const params = this.input_schema.parse(args);
      const target = this._resolve(params.path || '.', context.workspace);
      const targetStat = await fs.stat(target).catch(() => null);
      if (!targetStat) {
        return createToolError(`Error: Path not found: ${params.path || '.'}`);
      }
      if (!targetStat.isDirectory() && !targetStat.isFile()) {
        return createToolError(`Error: Unsupported path: ${params.path || '.'}`);
      }

      const flags = params.case_insensitive ? 'i' : '';
      let regex: RegExp;
      try {
        const needle = params.fixed_strings
          ? params.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          : params.pattern;
        regex = new RegExp(needle, flags);
      } catch (e) {
        return createToolError(`Error: invalid regex pattern: ${(e as Error).message}`);
      }

      const outputMode = params.output_mode || 'files_with_matches';
      let limit: number | null;
      if (params.head_limit !== undefined) {
        limit = params.head_limit === 0 ? null : params.head_limit;
      } else if (outputMode === 'content' && params.max_matches !== undefined) {
        limit = params.max_matches;
      } else if (outputMode !== 'content' && params.max_results !== undefined) {
        limit = params.max_results;
      } else {
        limit = _DEFAULT_HEAD_LIMIT;
      }

      const blocks: string[] = [];
      let resultChars = 0;
      let seenContentMatches = 0;
      let truncated = false;
      let sizeTruncated = false;
      let skippedBinary = 0;
      let skippedLarge = 0;
      const matchingFiles: string[] = [];
      const counts: Record<string, number> = {};
      const fileMtimes: Record<string, number> = {};
      const root = targetStat.isDirectory() ? target : path.dirname(target);

      const files = await this._iterFiles(target);
      for (const filePath of files) {
        const relPath = path.relative(root, filePath).split(path.sep).join('/');
        const name = path.basename(filePath);

        if (params.glob && !_matchGlob(relPath, name, params.glob)) continue;
        if (!_matchesType(name, params.type)) continue;

        let raw: Buffer;
        try {
          raw = await fs.readFile(filePath);
        } catch {
          continue;
        }

        if (raw.length > _MAX_FILE_BYTES) {
          skippedLarge++;
          continue;
        }
        if (_isBinary(raw)) {
          skippedBinary++;
          continue;
        }

        let mtime: number;
        try {
          const stat = await fs.stat(filePath);
          mtime = stat.mtimeMs;
        } catch {
          mtime = 0;
        }

        let content: string;
        try {
          content = raw.toString('utf-8');
        } catch {
          skippedBinary++;
          continue;
        }

        const lines = content.split('\n');
        const displayPath = this._displayPath(filePath, root, context.workspace);
        let fileHadMatch = false;

        for (let idx = 0; idx < lines.length; idx++) {
          const line = lines[idx];
          if (!regex.test(line)) continue;
          fileHadMatch = true;

          if (outputMode === 'count') {
            counts[displayPath] = (counts[displayPath] || 0) + 1;
            continue;
          }
          if (outputMode === 'files_with_matches') {
            if (!matchingFiles.includes(displayPath)) {
              matchingFiles.push(displayPath);
              fileMtimes[displayPath] = mtime;
            }
            break;
          }

          seenContentMatches++;
          const offset = params.offset || 0;
          if (seenContentMatches <= offset) continue;
          if (limit !== null && blocks.length >= limit) {
            truncated = true;
            break;
          }
          const block = this._formatBlock(
            displayPath,
            lines,
            idx + 1,
            params.context_before || 0,
            params.context_after || 0,
          );
          const extraSep = blocks.length > 0 ? 2 : 0;
          if (resultChars + extraSep + block.length > _MAX_RESULT_CHARS) {
            sizeTruncated = true;
            break;
          }
          blocks.push(block);
          resultChars += extraSep + block.length;
        }

        if (outputMode === 'count' && fileHadMatch) {
          if (!matchingFiles.includes(displayPath)) {
            matchingFiles.push(displayPath);
            fileMtimes[displayPath] = mtime;
          }
        }
        if (['count', 'files_with_matches'].includes(outputMode) && fileHadMatch) {
          continue;
        }
        if (truncated || sizeTruncated) break;
      }

      let result: string;
      if (outputMode === 'files_with_matches') {
        if (matchingFiles.length === 0) {
          result = `No matches found for pattern '${params.pattern}' in ${params.path || '.'}`;
        } else {
          const orderedFiles = matchingFiles.sort(
            (a, b) => (fileMtimes[b] || 0) - (fileMtimes[a] || 0) || a.localeCompare(b),
          );
          const offset = params.offset || 0;
          const [paged, isTruncated] = _paginate(orderedFiles, limit, offset);
          result = paged.join('\n');
          truncated = isTruncated;
        }
      } else if (outputMode === 'count') {
        if (Object.keys(counts).length === 0) {
          result = `No matches found for pattern '${params.pattern}' in ${params.path || '.'}`;
        } else {
          const orderedFiles = matchingFiles.sort(
            (a, b) => (fileMtimes[b] || 0) - (fileMtimes[a] || 0) || a.localeCompare(b),
          );
          const offset = params.offset || 0;
          const [ordered, isTruncated] = _paginate(orderedFiles, limit, offset);
          result = ordered.map(name => `${name}: ${counts[name]}`).join('\n');
          truncated = isTruncated;
        }
      } else {
        if (blocks.length === 0) {
          result = `No matches found for pattern '${params.pattern}' in ${params.path || '.'}`;
        } else {
          result = blocks.join('\n\n');
        }
      }

      const notes: string[] = [];
      if (outputMode === 'content' && truncated) {
        notes.push(`(pagination: limit=${limit}, offset=${params.offset || 0})`);
      } else if (outputMode === 'content' && sizeTruncated) {
        notes.push('(output truncated due to size)');
      } else if (truncated && ['count', 'files_with_matches'].includes(outputMode)) {
        notes.push(`(pagination: limit=${limit}, offset=${params.offset || 0})`);
      } else if (['count', 'files_with_matches'].includes(outputMode) && (params.offset || 0) > 0) {
        notes.push(`(pagination: offset=${params.offset || 0})`);
      } else if (outputMode === 'content' && (params.offset || 0) > 0 && blocks.length > 0) {
        notes.push(`(pagination: offset=${params.offset || 0})`);
      }
      if (skippedBinary > 0) {
        notes.push(`(skipped ${skippedBinary} binary/unreadable files)`);
      }
      if (skippedLarge > 0) {
        notes.push(`(skipped ${skippedLarge} large files)`);
      }
      if (outputMode === 'count' && Object.keys(counts).length > 0) {
        const total = Object.values(counts).reduce((a, b) => a + b, 0);
        notes.push(`(total matches: ${total} in ${Object.keys(counts).length} files)`);
      }
      if (notes.length > 0) {
        result += '\n\n' + notes.join('\n');
      }
      return createToolResult(result);
    } catch (err) {
      if ((err as Error).message.includes('permission')) {
        return createToolError(`Error: ${(err as Error).message}`);
      }
      return createToolError(`Error searching files: ${(err as Error).message}`);
    }
  }
}

export function getSearchTools(): BaseTool[] {
  return [new FindFilesTool(), new GrepTool()];
}
