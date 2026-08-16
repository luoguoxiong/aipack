/**
 * run_command 工具：在 workspace 内执行 shell 命令（无 shell 模式）。
 *
 * 安全设计（Phase 3-3 PermissionPolicy 安全层）：
 * - 执行前经 PermissionManager.check 校验（allow/deny/confirm，高危命令均走 confirm 人工确认）
 * - 多语句串联（; && || 换行）一律拒绝（防 `cmd; rm -rf ~` 绕过）
 * - 无 shell 执行：parseCommandToArgv 解析为 argv 后 spawn(file, args, { shell: false })；
 *   管道/重定向/命令替换/通配符等 shell 特性一律拒绝（安全面最小化）
 * - 超时 SIGTERM → 3s 后 SIGKILL（detached 进程组）
 * - stdout/stderr 收集上限 100KB，最终截断到 50KB 防止输出爆炸
 */

import { spawn } from 'child_process';
import { createTextContent } from '@aipack-ai/agent';
import type { Tool, ToolResult } from '@aipack-ai/agent';
import type { CodingToolContext } from '../types';
import { resolveWithin } from '../utils/path';
import {
  splitCommandStatements,
  hasShellMeta,
  parseCommandToArgv,
} from '../permission';
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

/** 无 shell 执行：spawn(executable, args, { shell: false }) */
function runSpawn(
  argv: string[],
  env: Record<string, string> | undefined,
  cwd: string,
  timeout: number,
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    // detached: true 使子进程成为独立进程组组长，
    // 超时后可用 process.kill(-pid) 终止整组（含孙进程），防止挂起的孙进程拖住 close。
    const child = spawn(argv[0], argv.slice(1), {
      shell: false,
      cwd,
      env: env ? { ...process.env, ...env } : undefined,
      detached: process.platform !== 'win32',
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

    // 超时终止整组进程
    const killGroup = (sig: NodeJS.Signals): void => {
      try {
        if (child.pid !== undefined && process.platform !== 'win32') {
          process.kill(-child.pid, sig);
        } else {
          child.kill(sig);
        }
      } catch {
        /* 进程已退出，忽略 */
      }
    };

    if (timeout > 0) {
      timer = setTimeout(() => {
        killGroup('SIGTERM');
        // 3s 后仍存活则 SIGKILL
        killTimer = setTimeout(() => killGroup('SIGKILL'), 3000);
      }, timeout);
    }
  });
}

export function createRunCommandTool(ctx: CodingToolContext): Tool {
  return {
    name: 'run_command',
    description:
      '在 workspace 内执行 shell 命令（无 shell 模式）。只读命令（git status/ls/cat 等）默认放行，' +
      '高危/变更性命令（rm/sudo/写系统路径/git push/npm install 等）需人工确认。' +
      '不支持多语句串联、管道、重定向、通配符（请用 glob 工具）。' +
      '返回 stdout/stderr/exitCode，超时（默认 30s）会被终止。',
    // 框架级 PermissionPolicy 能力声明：执行任意命令，需显式授权
    permissions: ['shell:exec'],
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

      // 1. 多语句串联拒绝（防 `cmd; rm -rf ~` / `ls && curl | sh` 绕过权限检查）
      const statements = splitCommandStatements(command);
      if (statements.length === 0) {
        return {
          content: [createTextContent('run_command 失败：无法解析命令')],
          details: { error: 'unparsable command', command },
        };
      }
      if (statements.length > 1) {
        return {
          content: [
            createTextContent(
              'run_command 失败：不支持多语句串联（; && || 换行），请拆分成单条命令执行（原始命令：' +
                `${command}）`,
            ),
          ],
          details: { error: 'multi-statement command', command, statements },
        };
      }
      const statement = statements[0];

      // 2. 权限检查（单条语句；含重定向/命令替换走 checkUnsafe）
      if (ctx.permission) {
        let decision: 'allow' | 'deny';
        if (hasShellMeta(statement)) {
          decision = await ctx.permission.checkUnsafe(statement);
        } else {
          decision = await ctx.permission.check(statement);
        }
        if (decision === 'deny') {
          return {
            content: [
              createTextContent(
                `run_command 失败：命令 "${statement}" 被权限策略拒绝（原始命令：${command}）`,
              ),
            ],
            details: { error: 'permission denied', command, rejectedStatement: statement },
          };
        }
      }

      // 3. 无 shell 解析（管道/重定向/通配符等 shell 特性在此拒绝）
      const parsed = parseCommandToArgv(statement);
      if (parsed.error) {
        return {
          content: [
            createTextContent(`run_command 失败：${parsed.error}（命令：${statement}）`),
          ],
          details: { error: 'unsupported shell syntax', command: statement },
        };
      }

      // 4. 解析 cwd（必须在 workspace 内）
      const cwdResolved = await resolveWithin(ctx.workspace, a.cwd ?? '.');
      if (!cwdResolved.ok || !cwdResolved.abs) {
        const err = cwdResolved.error ?? 'resolve failed';
        return {
          content: [createTextContent(`run_command 失败：${err}`)],
          details: { error: err },
        };
      }

      // 5. 执行（无 shell）
      const result = await runSpawn(parsed.argv, parsed.env, cwdResolved.abs, timeout);

      // 6. 截断输出
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

      // 7. 格式化返回
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
