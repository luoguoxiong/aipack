#!/usr/bin/env node
/**
 * aipack-coding CLI 入口。
 *
 * 命令：
 *   aipack-coding [chat]              交互式 coding REPL（默认）
 *   aipack-coding run "你的需求"      一次性执行
 *
 * 选项：
 *   -p, --provider <id>    模型提供商（deepseek/openai/anthropic）
 *   -m, --model <id>       模型 ID（deepseek-chat/gpt-4o-mini）
 *   -w, --workspace <path> 工作区路径（默认当前目录）
 */

import { loadEnv, resolveModelFromArgs } from './model';
import { startChat } from './chat';
import { runOnce } from './run';

interface ParsedArgs {
  command: string;
  provider?: string;
  model?: string;
  workspace?: string;
  memory?: boolean;
  message?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  let provider: string | undefined;
  let model: string | undefined;
  let workspace: string | undefined;
  let memory = false;
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-p' || a === '--provider') {
      provider = argv[++i];
      continue;
    }
    if (a === '-m' || a === '--model') {
      model = argv[++i];
      continue;
    }
    if (a === '-w' || a === '--workspace') {
      workspace = argv[++i];
      continue;
    }
    if (a === '--memory') {
      memory = true;
      continue;
    }
    if (a === '-h' || a === '--help') {
      return { command: 'help' };
    }
    if (a === '--') {
      // 显式分隔符：后续全部视为位置参数
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('-')) {
      // 未知 flag（含单横线）：跳过它；下一个非 flag token 视为其值一并跳过
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) i++;
      continue;
    }
    positional.push(a);
  }

  const command = positional[0] ?? 'chat';
  const message = positional.slice(command === 'run' ? 1 : 0).join(' ');
  return { command, provider, model, workspace, memory, message: message || undefined };
}

function showHelp(): void {
  console.log('aipack-coding - coding agent CLI');
  console.log('');
  console.log('用法:');
  console.log('  aipack-coding [chat]              交互式 coding REPL（默认）');
  console.log('  aipack-coding run "你的需求"      一次性执行');
  console.log('');
  console.log('选项:');
  console.log('  -p, --provider <id>    模型提供商（deepseek/openai/anthropic）');
  console.log('  -m, --model <id>       模型 ID（deepseek-chat/gpt-4o-mini）');
  console.log('  -w, --workspace <path> 工作区路径（默认当前目录）');
  console.log('  --memory               启用 aipack-memory 记忆集成');
  console.log('  -h, --help             显示帮助');
  console.log('');
  console.log('环境变量:');
  console.log('  DEEPSEEK_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY 等');
  console.log('  或写入 ~/.aipack/.env / <cwd>/.env');
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const parsed = parseArgs(argv);

  if (parsed.command === 'help') {
    showHelp();
    return;
  }

  loadEnv();

  // 提前验证模型可用（无 Key 时友好报错退出）
  resolveModelFromArgs({ provider: parsed.provider, model: parsed.model });

  if (parsed.command === 'run') {
    if (!parsed.message) {
      console.error('用法: aipack-coding run "你的需求"');
      process.exit(1);
    }
    await runOnce({
      message: parsed.message,
      provider: parsed.provider,
      model: parsed.model,
      workspace: parsed.workspace,
      memory: parsed.memory,
    });
  } else if (parsed.command === 'chat') {
    await startChat({
      provider: parsed.provider,
      model: parsed.model,
      workspace: parsed.workspace,
      memory: parsed.memory,
    });
  } else {
    console.error(`未知命令: ${parsed.command}`);
    console.error('可用命令: chat（默认）/ run');
    console.error('运行 "aipack-coding --help" 查看帮助');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('致命错误:', err);
  process.exit(1);
});
