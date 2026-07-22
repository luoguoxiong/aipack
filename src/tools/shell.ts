import { exec } from 'child_process';
import { promisify } from 'util';
import { Type } from "@earendil-works/pi-ai";
import { BaseTool, createToolResult, createToolError } from "./base.js";

const execAsync = promisify(exec);

export class ShellTool extends BaseTool<typeof ShellTool.parameters> {
  name = 'shell';
  label = 'Shell';
  description = 'Execute shell commands';
  static parameters = Type.Object({
    command: Type.String({ description: 'The shell command to execute' }),
    timeout: Type.Integer({ description: 'Timeout in seconds', default: 120 }),
  });
  parameters = ShellTool.parameters;

  async execute(toolCallId: string, params: { command: string; timeout: number }) {
    try {
      const { stdout, stderr } = await execAsync(params.command, { timeout: params.timeout * 1000 });
      const result = stderr ? `${stdout}\n--- STDERR ---\n${stderr}` : stdout;
      return createToolResult(result.trim() || '(empty output)');
    } catch (err) {
      const error = err as Error & { code?: number; stdout?: string; stderr?: string };
      const output = error.stdout || '';
      const errOutput = error.stderr || '';
      const result = `${output}\n--- ERROR ---\n${errOutput}\nExit code: ${error.code}`;
      return createToolError(result);
    }
  }
}

export class GitStatusTool extends BaseTool<typeof GitStatusTool.parameters> {
  name = 'git_status';
  label = 'Git Status';
  description = 'Get git status of the current repository';
  static parameters = Type.Object({});
  parameters = GitStatusTool.parameters;

  async execute(toolCallId: string) {
    try {
      const { stdout, stderr } = await execAsync('git status');
      const result = stderr ? `${stdout}\n${stderr}` : stdout;
      return createToolResult(result.trim());
    } catch (err) {
      return createToolError(`Git status failed: ${(err as Error).message}`);
    }
  }
}

export class GitLogTool extends BaseTool<typeof GitLogTool.parameters> {
  name = 'git_log';
  label = 'Git Log';
  description = 'Get recent git commit log';
  static parameters = Type.Object({
    limit: Type.Integer({ description: 'Number of commits to show', default: 10 }),
  });
  parameters = GitLogTool.parameters;

  async execute(toolCallId: string, params: { limit: number }) {
    try {
      const { stdout, stderr } = await execAsync(`git log --oneline -n ${params.limit}`);
      const result = stderr ? `${stdout}\n${stderr}` : stdout;
      return createToolResult(result.trim());
    } catch (err) {
      return createToolError(`Git log failed: ${(err as Error).message}`);
    }
  }
}

export function getShellTools(): BaseTool[] {
  return [
    new ShellTool(),
    new GitStatusTool(),
    new GitLogTool(),
  ];
}
