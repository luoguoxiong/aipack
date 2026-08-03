/**
 * run_command 工具：在 workspace 内执行 shell 命令。
 *
 * 执行前经 PermissionManager.check 校验（allow/deny/confirm）。
 * 用 child_process.spawn（shell 模式）执行，支持超时（SIGTERM → 3s 后 SIGKILL）。
 * stdout/stderr 收集上限 100KB，最终截断到 50KB 防止输出爆炸。
 */

import { spawn } from 'child_process';
import { createTextContent } from 'agentpack';
import type { Tool, ToolResult } from 'agentpack';
import type { CodingToolContext } from '../types';
import { resolveWithin } from '../utils/path';
import { truncateWithHint } from '../utils/text';

/** 收集上限（字节），最终截断到 50KB */
const COLLECT_LIMIT = 100_000;
const OUTPUT_LIMIT = 50_000;

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  signaled: boolean;
  durationMs: number;
}

function runSpawn(
  command: string,
  cwd: string,
  timeout: number,
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, {
      shell: true,
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timer: NodeJS.Timeout | null = null;
    let killTimer: NodeJS.Timeout | null = null;
    let done = false;

    const finish = (result: Partial<SpawnResult>): void => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        stdout,
        stderr,
        exitCode: result.exitCode ?? -1,
        signaled: result.signaled ?? false,
        durationMs: Date.now() - started,
      });
    };

    child.stdout?.on('data', (d: Buffer) => {
      if (stdout.length < COLLECT_LIMIT) {
        stdout += d.toString('utf-8').slice(0, COLLECT_LIMIT - stdout.length);
      }
    });
    child.stderr?.on('data', (d: Buffer) => {
      if (stderr.length < COLLECT_LIMIT) {
        stderr += d.toString('utf-8').slice(0, COLLECT_LIMIT - stderr.length);
      }
    });

    child.on('error', (err) => {
      stderr += `\n${err.message}`;
      finish({ exitCode: -1, signaled: false });
    });

    child.on('close', (code, signal) => {
      finish({ exitCode: code ?? -1, signaled: signal !== null });
    });

    if (timeout > 0) {
      timer = setTimeout(() => {
        try {
          child.kill('SIGTERM');
        } catch {
          /* ignore */
        }
        // 3s 后仍存活则 SIGKILL
        killTimer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            /* ignore */
          }
        }, 3000);
      }, timeout);
    }
  });
}

export function createRunCommandTool(ctx: CodingToolContext): Tool {
  return {
    name: 'run_command',
    description:
      '在 workspace 内执行 shell 命令。只读命令（git status/ls/cat 等）默认放行，' +
      '高危命令（rm 等）默认拒绝，变更性命令（git push/npm install 等）需确认。' +
      '返回 stdout/stderr/exitCode，超时（默认 30s）会被终止。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令（含参数）' },
        cwd: {
          type: 'string',
          description: '执行目录（相对 workspace，默认 workspace 根）',
        },
        timeout: {
          type: 'integer',
          description: '超时毫秒数（默认 30000，最大 300000）',
          minimum: 1000,
          maximum: 300000,
        },
      },
      required: ['command'],
    },
    async execute(_id, args): Promise<ToolResult> {
      const a = (args ?? {}) as { command?: string; cwd?: string; timeout?: number };
      if (!a.command || !a.command.trim()) {
        return {
          content: [createTextContent('run_command 失败：command 不能为空')],
          details: { error: 'empty command' },
        };
      }
      const command = a.command.trim();
      let timeout = a.timeout ?? 30000;
      if (timeout > 300000) timeout = 300000;

      // 1. 权限检查
      if (ctx.permission) {
        const decision = await ctx.permission.check(command);
        if (decision === 'deny') {
          return {
            content: [createTextContent(`run_command 失败：命令被权限策略拒绝：${command}`)],
            details: { error: 'permission denied', command },
          };
        }
      }

      // 2. 解析 cwd（必须在 workspace 内）
      const cwdResolved = resolveWithin(ctx.workspace, a.cwd ?? '.');
      if (!cwdResolved.ok || !cwdResolved.abs) {
        const err = cwdResolved.error ?? 'resolve failed';
        return {
          content: [createTextContent(`run_command 失败：${err}`)],
          details: { error: err },
        };
      }

      // 3. 执行
      const result = await runSpawn(command, cwdResolved.abs, timeout);

      // 4. 截断输出
      const stdout = truncateWithHint(
        result.stdout,
        OUTPUT_LIMIT,
        '\n... (stdout 已截断)',
      );
      const stderr = truncateWithHint(
        result.stderr,
        OUTPUT_LIMIT,
        '\n... (stderr 已截断)',
      );

      // 5. 格式化返回
      const parts: string[] = [];
      if (result.signaled) {
        parts.push(`[超时终止，耗时 ${result.durationMs}ms，exit ${result.exitCode}]`);
      } else {
        parts.push(`[exit ${result.exitCode}，耗时 ${result.durationMs}ms]`);
      }
      if (stdout) parts.push(stdout);
      if (stderr) parts.push(`[stderr]\n${stderr}`);

      return {
        content: [createTextContent(parts.join('\n'))],
        details: {
          command,
          exitCode: result.exitCode,
          signaled: result.signaled,
          durationMs: result.durationMs,
          stdoutLength: result.stdout.length,
          stderrLength: result.stderr.length,
        },
      };
    },
  };
}
