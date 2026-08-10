#!/usr/bin/env node

/**
 * packages/agentpack-cli/src/cli.ts
 *
 * commander 主程序：
 *   chat（默认） 交互式聊天
 *   continue     继续历史会话（恢复上下文后进入交互式聊天）
 *   run          一次性提问（缺省从标准输入读取）
 *   init         初始化配置文件（交互式向导）
 *   models       列出内置模型
 *   replay       回放历史会话
 *   sessions     list / clear / delete
 *   reset        all / config / logs / sessions / memory
 */

import { Command } from 'commander';
import { createFileSessionStorage, type AiModel } from 'agentpack';
import type { AgentpackConfig, CliOptions } from './config';
import { loadConfig } from './config';
import { loadEnvFile } from './env';
import { createAgentpackRuntime, resolveModelForCli } from './runtime';
import { hasAnyApiKey, runSetupWizard } from './setup-wizard';
import { runInitConfig } from './init-config';
import { startChat } from './chat';
import { runOnce } from './run';
import { replaySession } from './replay';
import { clearSessions, deleteSession, listSessions } from './sessions';
import { printModels } from './models';
import {
  confirmAction,
  resetAll,
  resetConfig,
  resetLogs,
  resetMemory,
  resetSessions,
} from './reset';

const program = new Command();

program
  .name('agentpack')
  .description('agentpack - 基于 agentpack 框架的 AI 命令行助手')
  .version('0.1.0');

program
  .option('-c, --config <path>', '配置文件路径（支持 .js/.json，默认合并 <cwd>/agentpack.config.js 与 ~/.agentpack/config.json）')
  .option('-p, --provider <provider>', '模型提供商（如 deepseek / openai）')
  .option('-m, --model <model>', '模型 ID（如 deepseek-chat / gpt-4o-mini）')
  .option('--system-prompt <text>', '系统提示词')
  .option('-w, --workspace <path>', '工作区路径')
  .option('--no-persist', '禁用会话持久化');

// ─── 通用初始化 ────────────────────────────────────────────────────

function getCliOptions(): CliOptions {
  const opts = program.opts();
  return {
    config: opts.config,
    provider: opts.provider,
    model: opts.model,
    systemPrompt: opts.systemPrompt,
    workspace: opts.workspace,
    noPersist: opts.persist === false,
  };
}

interface InitResult {
  config: AgentpackConfig;
  model: AiModel;
}

/**
 * 初始化：加载 .env + 配置 + 解析模型。
 * 无 API Key 且为交互式终端时，运行设置向导引导用户配置；否则给出可读错误并退出。
 */
async function init(): Promise<InitResult> {
  loadEnvFile();
  const cli = getCliOptions();

  let config = await loadConfig(cli);

  // 未检测到任何 API Key：交互式终端下运行设置向导
  if (!hasAnyApiKey()) {
    if (!process.stdin.isTTY) {
      console.error('❌ 未检测到任何 API Key。');
      console.error('   请在交互式终端运行 "agentpack chat" 进行首次配置，');
      console.error('   或在环境变量中配置，例如：export DEEPSEEK_API_KEY="your-key"');
      console.error('   或写入 ~/.agentpack/.env / <cwd>/.env 文件');
      console.error('   运行 "agentpack models" 查看支持的提供商与模型');
      process.exit(1);
    }

    // 向导内部会写入 API Key + AGENTPACK_PROVIDER/MODEL 到环境变量与 .env
    await runSetupWizard();
    config = await loadConfig(cli);
  }

  const model = resolveModelForCli(config);
  return { config, model };
}

function printInitInfo(config: AgentpackConfig, model: AiModel): void {
  console.log('✅ agentpack 初始化成功');
  console.log(`   模型: ${model.id} (${model.provider})`);
  console.log(
    `   会话: ${config.sessionKey}${
      config.sessions.enabled ? `（持久化：${config.sessions.baseDir}）` : '（未持久化）'
    }`,
  );
}

// ─── 命令：chat（默认） ────────────────────────────────────────────

program
  .command('chat', { isDefault: true })
  .description('启动交互式聊天（默认命令）')
  .action(async () => {
    const { config, model } = await init();
    const runtime = createAgentpackRuntime(config, model);
    printInitInfo(config, model);
    console.log('');
    await startChat(runtime, config, `${model.provider}/${model.id}`);
  });

// ─── 命令：continue ────────────────────────────────────────────────

program
  .command('continue')
  .description('继续某个历史会话（恢复上下文后进入交互式聊天）')
  .argument('<sessionKey>', '要继续的会话 key')
  .action(async (sessionKey: string) => {
    const { config, model } = await init();

    // 校验会话是否存在，给出可读错误
    const storage = createFileSessionStorage({ baseDir: config.sessions.baseDir });
    const stored = await storage.load(sessionKey);
    if (!stored) {
      console.error(`❌ 会话 "${sessionKey}" 未找到（存储目录：${config.sessions.baseDir}）`);
      console.error('   运行 "agentpack sessions list" 查看已有会话');
      process.exit(1);
    }

    // 用指定会话 key 覆盖自动生成的新 key，runtime 会 hydrate 加载历史上下文
    config.sessionKey = sessionKey;

    const runtime = createAgentpackRuntime(config, model);
    printInitInfo(config, model);
    console.log(`已恢复会话：${sessionKey}（${stored.messages.length} 条历史消息）`);
    console.log('');
    await startChat(runtime, config, `${model.provider}/${model.id}`);
  });

// ─── 命令：run ─────────────────────────────────────────────────────

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf-8').trim();
}

program
  .command('run')
  .description('一次性提问（缺省从标准输入读取消息）')
  .argument('[message...]', '要发送的消息')
  .action(async (messageArgs: string[]) => {
    let message = messageArgs.join(' ');
    if (!message.trim()) {
      message = await readStdin();
    }
    if (!message.trim()) {
      console.error('错误: 未提供消息，请直接传入参数或用管道传入');
      process.exit(1);
    }

    const { config, model } = await init();
    await runOnce(message, config, model);
  });

// ─── 命令：init ───────────────────────────────────────────────────

program
  .command('init')
  .description('初始化配置文件（交互式生成 agentpack.config.js / config.json）')
  .option('-g, --global', '写入全局配置 ~/.agentpack/config.json')
  .option('-l, --local', '写入项目级配置 <cwd>/agentpack.config.js')
  .option('-f, --force', '覆盖已存在的配置文件')
  .action(async (options: { global?: boolean; local?: boolean; force?: boolean }) => {
    if (options.global && options.local) {
      console.error('❌ --global 与 --local 不能同时使用。');
      process.exit(1);
    }
    await runInitConfig({
      target: options.global ? 'global' : options.local ? 'local' : undefined,
      force: options.force,
    });
  });

// ─── 命令：models ──────────────────────────────────────────────────

program
  .command('models')
  .description('列出内置模型（标注 API Key 配置状态）')
  .action(() => {
    loadEnvFile();
    printModels();
  });

// ─── 命令：replay ──────────────────────────────────────────────────

program
  .command('replay')
  .description('回放历史会话以复现问题')
  .argument('<sessionKey>', '要回放的会话 key')
  .option('--execute', '真实执行工具（默认只回放对话，不执行任何工具）')
  .action(async (sessionKey: string, opts: { execute?: boolean }) => {
    const { config, model } = await init();
    const dryRun = !opts.execute;

    console.log(`开始回放会话：${sessionKey}`);
    if (dryRun) {
      console.log('（dry-run：不执行任何工具，仅回放对话；使用 --execute 真实执行）');
    }
    console.log('----------------------------------------');

    try {
      const result = await replaySession(
        sessionKey,
        config,
        (current, total, message) => {
          console.log(
            `[${current}/${total}] 正在回放：${message.slice(0, 80)}${
              message.length > 80 ? '...' : ''
            }`,
          );
        },
        (current, total, turn) => {
          if (turn.error) {
            console.log(`  ❌ 错误：${turn.error}`);
          } else if (turn.response) {
            const preview = turn.response.slice(0, 300);
            console.log(
              `  🤖 响应：${preview}${turn.response.length > 300 ? '...' : ''}`,
            );
          } else {
            console.log('  ⚠️  无响应');
          }
          console.log('');
        },
        model,
        { dryRun },
      );

      console.log(
        `共 ${result.userMessageCount} 条用户消息，用时 ${(result.totalDurationMs / 1000).toFixed(1)}s`,
      );

      if (result.totalErrors > 0) {
        console.log(`💥 总计 ${result.totalErrors}/${result.userMessageCount} 轮出错`);
      } else {
        console.log('✅ 全部回放成功，未出现错误');
      }
    } catch (err) {
      console.error(`\n❌ 回放失败：${(err as Error).message}`);
      process.exit(1);
    }
  });

// ─── 命令：sessions ────────────────────────────────────────────────

const sessionsCmd = program.command('sessions').description('会话管理');

sessionsCmd
  .command('list')
  .description('列出所有已持久化的会话')
  .action(async () => {
    const config = await loadConfig(getCliOptions());
    const sessions = await listSessions(config);
    if (sessions.length === 0) {
      console.log('（无会话）');
      return;
    }
    for (const s of sessions) console.log(`  - ${s}`);
    console.log(`\n共 ${sessions.length} 个会话（存储目录：${config.sessions.baseDir}）`);
  });

sessionsCmd
  .command('clear')
  .description('清空所有会话')
  .option('-y, --yes', '跳过确认提示')
  .action(async (options: { yes?: boolean }) => {
    const config = await loadConfig(getCliOptions());
    const confirmed = await confirmAction(
      `⚠️  这将删除 ${config.sessions.baseDir} 中的所有会话数据。确定继续吗？`,
      options.yes ?? false,
    );
    if (!confirmed) {
      console.log('已取消。');
      return;
    }
    const count = await clearSessions(config);
    console.log(`✅ 已删除 ${count} 个会话`);
  });

sessionsCmd
  .command('delete')
  .description('删除指定会话')
  .argument('<sessionKey>', '要删除的会话 key')
  .action(async (sessionKey: string) => {
    const config = await loadConfig(getCliOptions());
    const ok = await deleteSession(config, sessionKey);
    console.log(ok ? `✅ 已删除会话：${sessionKey}` : `⚠️  会话不存在：${sessionKey}`);
  });

// ─── 命令：reset ───────────────────────────────────────────────────

const resetCmd = program.command('reset').description('重置 agentpack 数据（配置、日志、会话、记忆）');

resetCmd
  .command('all')
  .description('重置所有数据（配置、日志、会话、记忆）')
  .option('-y, --yes', '跳过确认提示')
  .action(async (options: { yes?: boolean }) => {
    await resetAll(options.yes ?? false);
  });

resetCmd
  .command('config')
  .description('重置用户级配置为默认值（删除 config.json 与 .env）')
  .option('-y, --yes', '跳过确认提示')
  .action(async (options: { yes?: boolean }) => {
    await resetConfig(options.yes ?? false);
  });

resetCmd
  .command('logs')
  .description('清空所有日志文件')
  .option('-y, --yes', '跳过确认提示')
  .action(async (options: { yes?: boolean }) => {
    await resetLogs(options.yes ?? false);
  });

resetCmd
  .command('sessions')
  .description('清空所有会话数据')
  .option('-y, --yes', '跳过确认提示')
  .action(async (options: { yes?: boolean }) => {
    await resetSessions(options.yes ?? false);
  });

resetCmd
  .command('memory')
  .description('清空所有记忆数据')
  .option('-y, --yes', '跳过确认提示')
  .action(async (options: { yes?: boolean }) => {
    await resetMemory(options.yes ?? false);
  });

// ─── 启动 ──────────────────────────────────────────────────────────

program.parseAsync(process.argv).catch((err) => {
  console.error('致命错误:', err);
  process.exit(1);
});
