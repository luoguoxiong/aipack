import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { logger } from './logger.js';

export interface CommitInfo {
  sha: string;
  message: string;
  timestamp: string;
}

export interface LineAge {
  age_days: number;
}

const _WORKING_TREE_DIFF_MAX_CHARS = 6000;

export class GitStore {
  private workspace: string;
  private trackedFiles: string[];

  constructor(workspace: string, trackedFiles: string[]) {
    this.workspace = path.resolve(workspace);
    this.trackedFiles = trackedFiles;
  }

  isInitialized(): boolean {
    return fs.existsSync(path.join(this.workspace, '.git'));
  }

  private _runGit(args: string[]): string {
    try {
      return execSync(`git ${args.join(' ')}`, {
        cwd: this.workspace,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch {
      return '';
    }
  }

  private _isInsideGitRepo(): boolean {
    let current = this.workspace;
    while (true) {
      if (fs.existsSync(path.join(current, '.git'))) {
        return true;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
    return false;
  }

  init(): boolean {
    if (this.isInitialized()) {
      return false;
    }

    if (this._isInsideGitRepo()) {
      logger.warn({ workspace: this.workspace }, 'Workspace already inside a git repo; skipping nested repo init');
      return false;
    }

    try {
      this._runGit(['init']);

      const gitignorePath = path.join(this.workspace, '.gitignore');
      const dreamEntries = this._buildGitignore();
      if (fs.existsSync(gitignorePath)) {
        const existing = fs.readFileSync(gitignorePath, 'utf-8');
        const existingLines = new Set(existing.split('\n').map(l => l.trim()));
        const newLines = dreamEntries
          .split('\n')
          .filter(line => !existingLines.has(line.trim()));
        if (newLines.length > 0) {
          const merged = existing.trimEnd() + '\n' + newLines.join('\n') + '\n';
          fs.writeFileSync(gitignorePath, merged, 'utf-8');
        }
      } else {
        fs.writeFileSync(gitignorePath, dreamEntries, 'utf-8');
      }

      for (const rel of this.trackedFiles) {
        const p = path.join(this.workspace, rel);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        if (!fs.existsSync(p)) {
          fs.writeFileSync(p, '', 'utf-8');
        }
      }

      this._runGit(['add', '.gitignore', ...this.trackedFiles]);
      this._runGit(['commit', '-m', 'init: nanobot memory store', '--author=nanobot <nanobot@dream>']);

      logger.info({ workspace: this.workspace }, 'Git store initialized');
      return true;
    } catch (err) {
      logger.error({ err, workspace: this.workspace }, 'Git store init failed');
      return false;
    }
  }

  autoCommit(message: string): string | null {
    if (!this.isInitialized()) {
      return null;
    }

    try {
      const status = this._runGit(['status', '--porcelain']);
      if (!status) {
        return null;
      }

      this._runGit(['add', ...this.trackedFiles]);
      const output = this._runGit([
        'commit',
        '-m',
        message,
        '--author=nanobot <nanobot@dream>',
      ]);

      if (!output) {
        return null;
      }

      const sha = this._runGit(['rev-parse', '--short=8', 'HEAD']);
      logger.debug({ sha, message }, 'Git auto-commit');
      return sha || null;
    } catch (err) {
      logger.error({ err, message }, 'Git auto-commit failed');
      return null;
    }
  }

  private _buildGitignore(): string {
    const dirs = new Set<string>();
    for (const f of this.trackedFiles) {
      const parent = path.dirname(f);
      if (parent !== '.') {
        dirs.add(parent);
      }
    }
    const lines = ['/*'];
    for (const d of [...dirs].sort()) {
      lines.push(`!${d}/`);
    }
    for (const f of this.trackedFiles) {
      lines.push(`!${f}`);
    }
    lines.push('!.gitignore');
    return lines.join('\n') + '\n';
  }

  log(maxEntries = 20, messagePrefix?: string): CommitInfo[] {
    if (!this.isInitialized()) {
      return [];
    }

    try {
      const format = '%h|%s|%ai';
      const args = ['log', `--format=${format}`, `-${maxEntries * 3}`];
      if (messagePrefix) {
        args.push(`--grep=^${messagePrefix}`);
      }
      const output = this._runGit(args);
      if (!output) {
        return [];
      }

      const entries: CommitInfo[] = [];
      for (const line of output.split('\n')) {
        if (!line) continue;
        const parts = line.split('|');
        if (parts.length >= 3) {
          entries.push({
            sha: parts[0],
            message: parts.slice(1, -1).join('|'),
            timestamp: parts[parts.length - 1],
          });
          if (entries.length >= maxEntries) {
            break;
          }
        }
      }
      return entries;
    } catch (err) {
      logger.error({ err }, 'Git log failed');
      return [];
    }
  }

  diffCommits(sha1: string, sha2: string): string {
    if (!this.isInitialized()) {
      return '';
    }
    try {
      return this._runGit(['diff', sha1, sha2]);
    } catch (err) {
      logger.error({ err }, 'Git diff failed');
      return '';
    }
  }

  showCommitDiff(
    shortSha: string,
    opts: { max_entries?: number; message_prefix?: string } = {},
  ): { commit: CommitInfo; diff: string } | null {
    const commits = this.log(opts.max_entries || 20, opts.message_prefix);
    for (const c of commits) {
      if (c.sha.startsWith(shortSha)) {
        const parent = this._runGit(['rev-list', '--parents', '-n', '1', c.sha]).split(' ')[1];
        const diff = parent ? this.diffCommits(parent, c.sha) : '';
        return { commit: c, diff };
      }
    }
    return null;
  }

  revert(commit: string, opts: { message_prefix?: string } = {}): string | null {
    if (!this.isInitialized()) {
      return null;
    }

    try {
      const showOutput = this._runGit(['show', '--format=%s', '-s', commit]);
      if (opts.message_prefix && !showOutput.startsWith(opts.message_prefix)) {
        logger.warn({ commit, prefix: opts.message_prefix }, "Git revert: commit doesn't match message prefix");
        return null;
      }

      this._runGit(['revert', '--no-edit', commit]);
      const sha = this._runGit(['rev-parse', '--short=8', 'HEAD']);
      return sha || null;
    } catch (err) {
      logger.error({ err, commit }, 'Git revert failed');
      return null;
    }
  }

  lineAges(filePath: string): LineAge[] {
    if (!this.isInitialized()) {
      return [];
    }

    const target = path.join(this.workspace, filePath);
    if (!fs.existsSync(target) || fs.statSync(target).size === 0) {
      return [];
    }

    try {
      const output = this._runGit(['blame', '--line-porcelain', filePath]);
      if (!output) {
        return [];
      }

      const ages: LineAge[] = [];
      const now = new Date();
      const lines = output.split('\n');
      let currentTime: number | null = null;

      for (const line of lines) {
        if (line.startsWith('committer-time ')) {
          currentTime = parseInt(line.slice('committer-time '.length), 10);
        }
        if (line.startsWith('\t') && currentTime !== null) {
          const commitDate = new Date(currentTime * 1000);
          const ageDays = Math.floor((now.getTime() - commitDate.getTime()) / (1000 * 60 * 60 * 24));
          ages.push({ age_days: ageDays });
          currentTime = null;
        }
      }

      return ages;
    } catch (err) {
      logger.error({ err, file_path: filePath }, 'Git line_ages failed');
      return [];
    }
  }

  summarizeWorkingTree(paths: string[]): string {
    if (!this.isInitialized()) {
      return '';
    }

    try {
      const summaryLines: string[] = [];
      const diffLines: string[] = [];
      let totalAdded = 0;
      let totalRemoved = 0;
      let changed = 0;

      for (const relPath of paths) {
        const absPath = path.join(this.workspace, relPath);
        let headText = '';
        try {
          headText = this._runGit(['show', `HEAD:${relPath}`]);
        } catch {
          headText = '';
        }

        let wtText = '';
        try {
          if (fs.existsSync(absPath)) {
            wtText = fs.readFileSync(absPath, 'utf-8');
          }
        } catch {
          changed++;
          summaryLines.push(`${relPath}: binary or non-UTF-8 file changed`);
          continue;
        }

        if (headText.replace(/\r\n/g, '\n') === wtText.replace(/\r\n/g, '\n')) {
          continue;
        }

        const headLines = headText.split('\n');
        const wtLines = wtText.split('\n');
        changed++;

        const hunks = _unifiedDiff(headLines, wtLines, relPath, relPath);
        const added = hunks.filter(l => l.startsWith('+') && !l.startsWith('+++')).length;
        const removed = hunks.filter(l => l.startsWith('-') && !l.startsWith('---')).length;
        totalAdded += added;
        totalRemoved += removed;
        summaryLines.push(`${relPath}: +${added} -${removed}`);
        diffLines.push(...hunks);
      }

      if (changed === 0) {
        return '';
      }

      let diffText = diffLines.join('\n');
      if (diffText.length > _WORKING_TREE_DIFF_MAX_CHARS) {
        diffText = diffText.slice(0, _WORKING_TREE_DIFF_MAX_CHARS) + '\n...[diff truncated]';
      }

      let body = summaryLines.join('\n');
      body += `\n${changed} file${changed !== 1 ? 's' : ''} changed, ${totalAdded} insertion${totalAdded !== 1 ? 's' : ''}(+), ${totalRemoved} deletion${totalRemoved !== 1 ? 's' : ''}(-)`;
      if (diffLines.length > 0) {
        body += `\n\n\`\`\`diff\n${diffText}\n\`\`\``;
      }
      return body;
    } catch (err) {
      logger.error({ err }, 'Git summarize_working_tree failed');
      return '';
    }
  }
}

function _unifiedDiff(
  originalLines: string[],
  modifiedLines: string[],
  fromFile: string,
  toFile: string,
  contextLines = 3,
): string[] {
  const result: string[] = [];
  result.push(`--- ${fromFile}`);
  result.push(`+++ ${toFile}`);

  const lenOrig = originalLines.length;
  const lenMod = modifiedLines.length;
  const dp: number[][] = [];
  for (let i = 0; i <= lenOrig; i++) {
    dp[i] = new Array(lenMod + 1).fill(0);
  }

  for (let i = lenOrig - 1; i >= 0; i--) {
    for (let j = lenMod - 1; j >= 0; j--) {
      if (originalLines[i] === modifiedLines[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  const hunks: Array<{ origStart: number; modStart: number; lines: string[] }> = [];
  let i = 0;
  let j = 0;
  let currentHunk: Array<{ origStart: number; modStart: number; lines: string[] }> | null = null;

  while (i < lenOrig || j < lenMod) {
    if (i < lenOrig && j < lenMod && originalLines[i] === modifiedLines[j]) {
      if (currentHunk && currentHunk[0].lines.length > 0) {
        const lastLine = currentHunk[0].lines[currentHunk[0].lines.length - 1];
        if (!lastLine.startsWith(' ')) {
          currentHunk[0].lines.push(' ' + originalLines[i]);
        } else {
          let contextCount = 0;
          for (let k = currentHunk[0].lines.length - 1; k >= 0; k--) {
            if (currentHunk[0].lines[k].startsWith(' ')) {
              contextCount++;
            } else {
              break;
            }
          }
          if (contextCount < contextLines * 2) {
            currentHunk[0].lines.push(' ' + originalLines[i]);
          } else {
            currentHunk[0].lines = currentHunk[0].lines.slice(0, -(contextCount - contextLines));
            currentHunk = null;
          }
        }
      }
      i++;
      j++;
    } else {
      if (!currentHunk) {
        const origStart = Math.max(0, i - contextLines) + 1;
        const modStart = Math.max(0, j - contextLines) + 1;
        const hunk = { origStart, modStart, lines: [] as string[] };
        for (let k = i - contextLines; k < i; k++) {
          if (k >= 0) {
            hunk.lines.push(' ' + originalLines[k]);
          }
        }
        hunks.push(hunk);
        currentHunk = [hunk];
      }
      if (i < lenOrig && (j >= lenMod || dp[i + 1][j] >= dp[i][j + 1])) {
        currentHunk[0].lines.push('-' + originalLines[i]);
        i++;
      } else {
        currentHunk[0].lines.push('+' + modifiedLines[j]);
        j++;
      }
    }
  }

  for (const hunk of hunks) {
    let origCount = 0;
    let modCount = 0;
    for (const line of hunk.lines) {
      if (line.startsWith('-') || line.startsWith(' ')) origCount++;
      if (line.startsWith('+') || line.startsWith(' ')) modCount++;
    }
    result.push(`@@ -${hunk.origStart},${origCount} +${hunk.modStart},${modCount} @@`);
    result.push(...hunk.lines.slice(-contextLines * 2 - 10000 > 0 ? 0 : 0));
    result.push(...hunk.lines);
  }

  return result.slice(0, 500);
}
