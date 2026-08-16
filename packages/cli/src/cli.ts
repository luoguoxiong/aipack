#!/usr/bin/env node
/**
 * aipack CLI 入口：子命令分发 + 模式路由
 */
import chalk from 'chalk';
import type { PermissionRequest } from '@aipack-ai/agent';
import { handleApprovalsCommand } from './commands/approvals.js';
import { listModels } from './commands/models.js';
import { parseArgs, printHelp } from './args.js';
import { buildRuntime } from './builder.js';
import { buildInitialMessage } from './initial-message.js';
import { runPrintMode } from './modes/print.js';
import { runJsonMode } from './modes/json.js';
import { runInteractiveMode } from './modes/interactive.js';
import { readStreamAll } from './prompt.js';
import { createToolConfirmHandler } from './confirm.js';
import { createRequest } from '@aipack-ai/agent';
import { VERSION } from './version.js';

export async function main(argv: string[]): Promise<number> {
  // ── 子命令：approvals ──
  if (argv[0] === 'approvals' || argv[0] === 'approval') {
    return handleApprovalsCommand(argv.slice(1));
  }

  // ── 参数解析 ──
  const args = parseArgs(argv);

  if (args.help) {
    printHelp();
    return 0;
  }
  if (args.version) {
    console.log(VERSION);
    return 0;
  }

  const errors = args.diagnostics.filter(d => d.type === 'error');
  if (errors.length > 0) {
    for (const e of errors) console.error(chalk.red(e.message));
    printHelp();
    return 1;
  }
  for (const w of args.diagnostics.filter(d => d.type === 'warning')) {
    console.error(chalk.yellow(w.message));
  }

  // ── --list-models ──
  if (args.listModels !== undefined) {
    return listModels(args.listModels);
  }

  // ── 管道 stdin（print / json 模式）──
  let stdinText: string | undefined;
  if ((args.print || args.mode === 'json') && !process.stdin.isTTY) {
    stdinText = await readStreamAll(process.stdin);
  }

  // ── 初始消息 ──
  const initial = await buildInitialMessage(args.messages, args.fileArgs, stdinText);

  const isNonInteractive = args.print || args.mode === 'json';
  if (isNonInteractive && !initial.text.trim() && initial.media.length === 0) {
    console.error(chalk.red('非交互模式需要提供消息（位置参数、@文件或管道 stdin）'));
    return 1;
  }

  // ── confirm 委托：选择式确认（方向键），交互模式接管后包装 rl 重建 ──
  // 默认自动放行非危险命令；--safe 时全部人工确认
  const toolConfirm = createToolConfirmHandler({ autoApproveSafe: !args.safe });
  const confirmRef: { fn: (req: PermissionRequest) => Promise<boolean> } = {
    fn: req => toolConfirm(req),
  };

  // ── 构建 Runtime ──
  let built;
  try {
    built = await buildRuntime({
      args,
      cwd: process.cwd(),
      confirmFn: req => confirmRef.fn(req),
    });
  } catch (err) {
    console.error(chalk.red(`初始化失败: ${err instanceof Error ? err.message : String(err)}`));
    return 1;
  }

  // ── 模式分发 ──
  try {
    if (args.mode === 'json') {
      const request = createRequest(initial.text || '(空)', {
        channel: 'cli',
        sessionKey: built.sessionKey,
        ephemeral: args.noSession,
        media: initial.media,
      });
      await runJsonMode(built.runtime, request);
    } else if (args.print) {
      const request = createRequest(initial.text || '(空)', {
        channel: 'cli',
        sessionKey: built.sessionKey,
        ephemeral: args.noSession,
        media: initial.media,
      });
      await runPrintMode(built.runtime, request);
    } else {
      await runInteractiveMode({
        runtime: built.runtime,
        sessionKey: built.sessionKey,
        model: built.model,
        args,
        storage: built.storage,
        approvalManager: built.approvalManager,
        initialMessages: args.messages.length > 0 ? [initial.text] : [],
        confirmRef,
        baseConfirm: toolConfirm,
      });
    }
  } finally {
    built.approvalManager?.close();
    await built.runtime.close();
  }

  return process.exitCode === 1 ? 1 : 0;
}

// ── 直接执行（bin）──
if (process.argv[1] && process.argv[1].endsWith('cli.js')) {
  main(process.argv.slice(2))
    .then(code => process.exit(code))
    .catch(err => {
      console.error(chalk.red(`致命错误: ${err instanceof Error ? err.stack ?? err.message : String(err)}`));
      process.exit(1);
    });
}
