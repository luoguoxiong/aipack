import { exec } from 'child_process';
import { promisify } from 'util';
import { Type } from "../pi/ai";
import { BaseTool, createToolResult, createToolError } from './base';

const execAsync = promisify(exec);

export class ShellTool extends BaseTool<typeof ShellTool.parameters> {
  name = 'shell';
  label = 'Shell';
  description = '执行 Shell 命令';
  static parameters = Type.Object({
    command: Type.String({ description: '要执行的 Shell 命令' }),
    timeout: Type.Integer({ description: '超时时间（秒）', default: 120 }),
  });
  parameters = ShellTool.parameters;

  async execute(toolCallId: string, params: { command: string; timeout: number }) {
    try {
      const { stdout, stderr } = await execAsync(params.command, { timeout: params.timeout * 1000 });
      const result = stderr ? `${stdout}\n--- STDERR ---\n${stderr}` : stdout;
      return createToolResult(result.trim() || '（空输出）');
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
  description = '获取当前仓库的 Git 状态';
  static parameters = Type.Object({});
  parameters = GitStatusTool.parameters;

  async execute(toolCallId: string) {
    try {
      const { stdout, stderr } = await execAsync('git status');
      const result = stderr ? `${stdout}\n${stderr}` : stdout;
      return createToolResult(result.trim());
    } catch (err) {
      return createToolError(`Git 状态获取失败：${(err as Error).message}`);
    }
  }
}

export class GitLogTool extends BaseTool<typeof GitLogTool.parameters> {
  name = 'git_log';
  label = 'Git Log';
  description = '获取最近的 Git 提交日志';
  static parameters = Type.Object({
    limit: Type.Integer({ description: '要显示的提交数量', default: 10 }),
  });
  parameters = GitLogTool.parameters;

  async execute(toolCallId: string, params: { limit: number }) {
    try {
      const { stdout, stderr } = await execAsync(`git log --oneline -n ${params.limit}`);
      const result = stderr ? `${stdout}\n${stderr}` : stdout;
      return createToolResult(result.trim());
    } catch (err) {
      return createToolError(`Git 日志获取失败：${(err as Error).message}`);
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
