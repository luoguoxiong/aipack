import { Type } from "@earendil-works/pi-ai";
import { BaseTool, createToolResult, createToolError } from "./base.js";
import { spawn } from 'child_process';

const IGNORE_DIRS = [
  '.git', '.hg', '.svn', '__pycache__', '.pytest_cache', '.mypy_cache',
  'node_modules', '.next', '.nuxt', 'dist', 'build', '.venv', 'venv',
  '.idea', '.vscode', '.tox', 'target', '.cargo', '.gradle', 'vendor',
  '.nanobot',
];

const IGNORE_FILES = [
  '.map', '.log', 'yarn.lock', 'package-lock.json',
];

export class FindFilesTool extends BaseTool<typeof FindFilesTool.parameters> {
  name = 'find_files';
  label = 'Find Files';
  description = 'Find files matching a pattern. Skips common dependency/build directories like node_modules, dist, .git, etc.';
  static parameters = Type.Object({
    pattern: Type.String({ description: 'Glob pattern to match' }),
    path: Type.String({ description: 'Directory to search in', default: '.' }),
  });
  parameters = FindFilesTool.parameters;

  async execute(toolCallId: string, params: { pattern: string; path: string }) {
    try {
      const files = await this.glob(params.pattern, params.path);
      if (files.length === 0) {
        return createToolResult('No files found');
      }
      return createToolResult(files.join('\n'));
    } catch (err) {
      return createToolError(`Failed to find files: ${(err as Error).message}`);
    }
  }

  private async glob(pattern: string, basePath: string): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const cmd = process.platform === 'win32' ? 'powershell' : 'bash';
      
      const excludeDirs = IGNORE_DIRS.map(d => `"${d}"`).join(',');
      const args = process.platform === 'win32' 
        ? ['-Command', `Get-ChildItem -Path "${basePath}" -Recurse -Include "${pattern}" -Exclude ${excludeDirs} | Select-Object -ExpandProperty FullName`]
        : ['-c', `find "${basePath}" -name "${pattern}" ${IGNORE_DIRS.map(d => `-not -path "*/${d}/*"`).join(' ')} 2>/dev/null`];
      
      const child = spawn(cmd, args);
      let output = '';
      
      child.stdout.on('data', (data) => output += data.toString());
      child.stderr.on('data', () => {});
      
      child.on('close', (code) => {
        if (code === 0) {
          const files = output.trim().split('\n').filter(f => f);
          resolve(files);
        } else {
          resolve([]);
        }
      });
    });
  }
}

export class GrepTool extends BaseTool<typeof GrepTool.parameters> {
  name = 'grep';
  label = 'Grep';
  description = 'Search for text in files. Skips common dependency/build directories like node_modules, dist, .git, etc.';
  static parameters = Type.Object({
    pattern: Type.String({ description: 'Search pattern' }),
    path: Type.String({ description: 'Directory or file to search in', default: '.' }),
    max_lines: Type.Integer({ description: 'Maximum number of lines to return', default: 20 }),
  });
  parameters = GrepTool.parameters;

  async execute(toolCallId: string, params: { pattern: string; path: string; max_lines: number }) {
    try {
      const results = await this.search(params.pattern, params.path);
      if (results.length === 0) {
        return createToolResult('No matches found');
      }
      return createToolResult(results.slice(0, params.max_lines).join('\n'));
    } catch (err) {
      return createToolError(`Search failed: ${(err as Error).message}`);
    }
  }

  private async search(pattern: string, basePath: string): Promise<string[]> {
    return new Promise((resolve) => {
      const cmd = process.platform === 'win32' ? 'powershell' : 'bash';
      
      const excludeDirs = IGNORE_DIRS.map(d => `"${d}"`).join(',');
      const excludeFiles = IGNORE_FILES.map(f => `"${f}"`).join(',');
      const args = process.platform === 'win32' 
        ? ['-Command', `Get-ChildItem -Path "${basePath}" -Recurse -Exclude ${excludeDirs},${excludeFiles} | Select-String -Pattern "${pattern}" | Select-Object -First 50`]
        : ['-c', `grep -rn "${pattern}" "${basePath}" ${IGNORE_DIRS.map(d => `--exclude-dir=${d}`).join(' ')} ${IGNORE_FILES.map(f => `--exclude="*${f}"`).join(' ')} 2>/dev/null`];
      
      const child = spawn(cmd, args);
      let output = '';
      
      child.stdout.on('data', (data) => output += data.toString());
      child.stderr.on('data', () => {});
      
      child.on('close', () => {
        const lines = output.trim().split('\n').filter(l => l);
        resolve(lines);
      });
    });
  }
}

export function getSearchTools(): BaseTool[] {
  return [
    new FindFilesTool(),
    new GrepTool(),
  ];
}
