import { BaseTool, ToolContext, ToolResult, createToolResult, createToolError } from './base.js';
import { z } from 'zod';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';

const execAsync = promisify(exec);

const ShellExecSchema = z.object({
  command: z.string().describe('The shell command to execute'),
  cwd: z.string().optional().describe('Working directory for the command'),
  timeout: z.number().int().optional().describe('Timeout in seconds'),
});

export class ShellExecTool extends BaseTool {
  name = 'shell_exec';
  description = 'Execute a shell command and return its output.';
  input_schema = ShellExecSchema;
  tags = ['shell', 'exec'];
  defaultTimeout = 120;

  async execute(args: unknown, context: ToolContext): Promise<ToolResult> {
    try {
      const params = this.input_schema.parse(args);
      const cwd = params.cwd
        ? this.resolvePath(params.cwd, context.workspace)
        : context.workspace || process.cwd();
      const timeout = (params.timeout || this.defaultTimeout) * 1000;

      const { stdout, stderr } = await execAsync(params.command, {
        cwd,
        timeout,
        shell: process.env.SHELL || '/bin/sh',
      });

      const output = (stdout || '') + (stderr ? `\n[stderr]\n${stderr}` : '');
      return createToolResult(output || '(no output)');
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; message?: string; killed?: boolean };
      let msg = `Command failed: ${e.message || 'unknown error'}`;
      if (e.stdout) msg += `\n[stdout]\n${e.stdout}`;
      if (e.stderr) msg += `\n[stderr]\n${e.stderr}`;
      if (e.killed) msg += '\n(Command timed out)';
      return createToolError(msg);
    }
  }

  private resolvePath(p: string, workspace?: string): string {
    if (path.isAbsolute(p)) {
      return p;
    }
    const base = workspace || process.cwd();
    return path.resolve(base, p);
  }
}

export function getShellTools(): BaseTool[] {
  return [new ShellExecTool()];
}
