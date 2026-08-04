#!/usr/bin/env node
/**
 * agentpack-coding CLI 入口。
 *
 * 命令：
 *   agentpack-coding [chat]              交互式 coding REPL（默认）
 *   agentpack-coding run "你的需求"      一次性执行
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
    if (a.startsWith('--')) {
      i++; // 跳过未知 flag 的值
      continue;
    }
    positional.push(a);
  }

  const command = positional[0] ?? 'chat';
  const message = positional.slice(command === 'run' ? 1 : 0).join(' ');
  return { command, provider, model, workspace, memory, message: message || undefined };
}

function showHelp(): void {
  console.log('agentpack-coding - coding agent CLI');
  console.log('');
  console.log('用法:');
  console.log('  agentpack-coding [chat]              交互式 coding REPL（默认）');
  console.log('  agentpack-coding run "你的需求"      一次性执行');
  console.log('');
  console.log('选项:');
  console.log('  -p, --provider <id>    模型提供商（deepseek/openai/anthropic）');
  console.log('  -m, --model <id>       模型 ID（deepseek-chat/gpt-4o-mini）');
  console.log('  -w, --workspace <path> 工作区路径（默认当前目录）');
  console.log('  --memory               启用 agentpack-memory 记忆集成');
  console.log('  -h, --help             显示帮助');
  console.log('');
  console.log('环境变量:');
  console.log('  DEEPSEEK_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY 等');
  console.log('  或写入 ~/.agentpack/.env / <cwd>/.env');
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
      console.error('用法: agentpack-coding run "你的需求"');
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
    console.error('运行 "agentpack-coding --help" 查看帮助');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('致命错误:', err);
  process.exit(1);
});
