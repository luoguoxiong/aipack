#!/usr/bin/env node

import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import os from 'os';
import readline from 'readline';
import { Kobot } from './kobot';
import { CLIChannel } from './channels/cli';
import { FeishuChannel } from './channels/feishu';
import { createLogger } from './utils/logger';
import { hasAnyApiKey, loadEnvFile, runSetupWizard } from './setup-wizard';
import { loadConfig, saveConfig, defaultConfig, getConfigPath } from './config';

const program = new Command();

program
  .name('kobot')
  .description('Kobot - 轻量级个人 AI 助手')
  .version('0.0.2');

program
  .command('start', { isDefault: true })
  .description('启动 Kobot 交互式命令行（默认命令）')
  .action(async () => {
    await startBot();
  });

program
  .command('replay')
  .description('回放历史会话以复现问题')
  .argument('<sessionKey>', '要回放的会话 key')
  .action(async (sessionKey: string) => {
    await replaySession(sessionKey);
  });

const resetCmd = program
  .command('reset')
  .description('重置 Kobot 数据 - 配置、日志、会话等');

const skillsCmd = program
  .command('skills')
  .description('管理 Skill 系统');

skillsCmd
  .command('list')
  .description('列出所有已注册的 Skill')
  .action(async () => {
    await runWithBot(async (bot) => {
      const sm = bot.skillManager_;
      if (!sm) {
        console.log('没有已注册的 Skill');
        return;
      }
      const skills = sm.listSkills();
      if (skills.length === 0) {
        console.log('没有已注册的 Skill');
        return;
      }
      for (const s of skills) {
        console.log(`  ${s.manifest.name} v${s.manifest.version} [${s.manifest.type}] - ${s.manifest.description}`);
      }
      console.log(`\n共 ${skills.length} 个 Skill`);
    });
  });

skillsCmd
  .command('reload')
  .description('重新加载所有 Skill')
  .action(async () => {
    await runWithBot(async (bot) => {
      const sm = bot.skillManager_;
      if (!sm) {
        console.log('Skill 系统未初始化');
        return;
      }
      const count = sm.reload();
      console.log(`已重新加载 ${count} 个 Skill`);
    });
  });

skillsCmd
  .command('traces')
  .description('查看最近 Skill 执行记录')
  .option('-n, --number <count>', '显示条数', '10')
  .action(async (options) => {
    await runWithBot(async (bot) => {
      const sm = bot.skillManager_;
      if (!sm) {
        console.log('Skill 系统未初始化');
        return;
      }
      const traces = sm.getTraces(parseInt(options.number, 10));
      if (traces.length === 0) {
        console.log('暂无执行记录');
        return;
      }
      for (const t of traces) {
        const statusIcon = t.status === 'success' ? '✅' : t.status === 'timeout' ? '⏰' : '❌';
        console.log(`  ${statusIcon} [${t.status}] ${t.skillName} - ${t.durationMs}ms, ${t.tokensUsed} tokens`);
        if (t.error) console.log(`     Error: ${t.error}`);
      }
    });
  });

resetCmd
  .command('all')
  .description('重置所有数据（配置、日志、会话、记忆）')
  .option('-y, --yes', '跳过确认提示')
  .action(async (options) => {
    await resetAll(options.yes);
  });

resetCmd
  .command('config')
  .description('重置配置为默认值')
  .option('-y, --yes', '跳过确认提示')
  .action(async (options) => {
    await resetConfig(options.yes);
  });

resetCmd
  .command('logs')
  .description('清空所有日志文件')
  .option('-y, --yes', '跳过确认提示')
  .action(async (options) => {
    await resetLogs(options.yes);
  });

resetCmd
  .command('sessions')
  .description('清空所有会话数据')
  .option('-y, --yes', '跳过确认提示')
  .action(async (options) => {
    await resetSessions(options.yes);
  });

resetCmd
  .command('memory')
  .description('清空所有记忆数据')
  .option('-y, --yes', '跳过确认提示')
  .action(async (options) => {
    await resetMemory(options.yes);
  });

async function confirmAction(message: string, skipConfirm: boolean): Promise<boolean> {
  if (skipConfirm) return true;
  
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  
  return new Promise((resolve) => {
    rl.question(`${message} (y/N): `, (answer: string) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}

function getConfigDir(): string {
  return process.env.KOBOT_CONFIG_DIR || path.join(os.homedir(), '.kobot');
}

function removeDirContents(dirPath: string): number {
  if (!fs.existsSync(dirPath)) return 0;
  
  let count = 0;
  const entries = fs.readdirSync(dirPath);
  
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry);
    const stat = fs.statSync(fullPath);
    
    if (stat.isDirectory()) {
      count += removeDirContents(fullPath);
      fs.rmdirSync(fullPath);
    } else {
      fs.unlinkSync(fullPath);
      count++;
    }
  }
  
  return count;
}

interface ResolvedPaths {
  configDir: string;
  configPath: string;
  envPath: string;
  workspaceDir: string;
  logsDir: string;
  sessionsDir: string;
  memoryDir: string;
}

async function resolvePaths(): Promise<ResolvedPaths> {
  const configDir = getConfigDir();
  const configPath = getConfigPath();
  const envPath = path.join(configDir, '.env');
  
  const defaultWorkspace = path.join(os.homedir(), '.kobot');
  const isCustomConfigDir = configDir !== defaultWorkspace;
  
  let workspaceDir = configDir;
  
  // 如果是自定义的 configDir（通过 KOBOT_CONFIG_DIR 设置），直接用它作为 workspace
  if (isCustomConfigDir) {
    workspaceDir = configDir;
  } else if (fs.existsSync(configPath)) {
    // 默认 configDir 情况下，读取配置文件获取 workspace
    try {
      const config = await loadConfig();
      workspaceDir = config.workspace_resolved || defaultWorkspace;
    } catch {
      workspaceDir = defaultWorkspace;
    }
  } else {
    workspaceDir = defaultWorkspace;
  }
  
  return {
    configDir,
    configPath,
    envPath,
    workspaceDir,
    logsDir: path.join(workspaceDir, 'logs'),
    sessionsDir: path.join(workspaceDir, 'sessions'),
    memoryDir: path.join(workspaceDir, 'memory'),
  };
}

async function resetAll(skipConfirm: boolean): Promise<void> {
  const paths = await resolvePaths();
  
  const confirmed = await confirmAction(
    '⚠️  这将重置所有数据，包括配置、日志、会话和记忆。确定继续吗？',
    skipConfirm
  );
  
  if (!confirmed) {
    console.log('已取消重置。');
    return;
  }
  
  console.log('🔄 正在重置所有 Kobot 数据...');
  
  doResetConfig(paths);
  doResetLogs(paths);
  doResetSessions(paths);
  doResetMemory(paths);
  
  console.log('\n✅ 所有数据重置完成。');
  console.log('   运行 "kobot start" 重新配置并启动 Kobot。');
}

async function resetConfig(skipConfirm: boolean): Promise<void> {
  const paths = await resolvePaths();
  
  const confirmed = await confirmAction(
    `⚠️  这将把配置重置为默认值并删除 .env 文件。\n   配置文件: ${paths.configPath}\n   .env 文件: ${paths.envPath}\n   确定继续吗？`,
    skipConfirm
  );
  
  if (!confirmed) {
    console.log('已取消重置。');
    return;
  }
  
  doResetConfig(paths);
}

function doResetConfig(paths: ResolvedPaths): void {
  console.log('🔄 正在重置配置...');
  
  if (fs.existsSync(paths.configPath)) {
    fs.unlinkSync(paths.configPath);
    console.log(`   ✅ 已删除 config.yaml`);
  } else {
    console.log(`   ℹ️  config.yaml 不存在，跳过`);
  }
  
  if (fs.existsSync(paths.envPath)) {
    fs.unlinkSync(paths.envPath);
    console.log(`   ✅ 已删除 .env`);
  } else {
    console.log(`   ℹ️  .env 不存在，跳过`);
  }
  
  // 重新生成默认配置 - 注意：默认配置中 workspace 是 ~/.kobot
  // 但 saveConfig 会保存到 paths.configPath 位置
  const config = defaultConfig();
  config.sessions = { storage: 'file', storage_path: 'sessions' };
  saveConfig(config, paths.configPath).then(() => {
    console.log(`   ✅ 已生成默认配置`);
  }).catch(() => {
    console.log(`   ⚠️  生成默认配置失败`);
  });
}

async function resetLogs(skipConfirm: boolean): Promise<void> {
  const paths = await resolvePaths();
  
  const confirmed = await confirmAction(
    `⚠️  这将清空以下目录中的所有日志文件:\n   ${paths.logsDir}\n   确定继续吗？`,
    skipConfirm
  );
  
  if (!confirmed) {
    console.log('已取消重置。');
    return;
  }
  
  doResetLogs(paths);
}

function doResetLogs(paths: ResolvedPaths): void {
  console.log('🔄 正在清空日志...');
  
  if (fs.existsSync(paths.logsDir)) {
    const count = removeDirContents(paths.logsDir);
    console.log(`   ✅ 已删除 ${count} 个日志文件`);
  } else {
    console.log(`   ℹ️  日志目录不存在，跳过`);
  }
}

async function resetSessions(skipConfirm: boolean): Promise<void> {
  const paths = await resolvePaths();
  
  const confirmed = await confirmAction(
    `⚠️  这将删除以下目录中的所有会话数据:\n   ${paths.sessionsDir}\n   确定继续吗？`,
    skipConfirm
  );
  
  if (!confirmed) {
    console.log('已取消重置。');
    return;
  }
  
  doResetSessions(paths);
}

function doResetSessions(paths: ResolvedPaths): void {
  console.log('🔄 正在清空会话...');
  
  if (fs.existsSync(paths.sessionsDir)) {
    const count = removeDirContents(paths.sessionsDir);
    console.log(`   ✅ 已删除 ${count} 个会话文件`);
  } else {
    console.log(`   ℹ️  会话目录不存在，跳过`);
  }
}

async function resetMemory(skipConfirm: boolean): Promise<void> {
  const paths = await resolvePaths();
  
  const confirmed = await confirmAction(
    `⚠️  这将删除以下目录中的所有记忆数据:\n   ${paths.memoryDir}\n   确定继续吗？`,
    skipConfirm
  );
  
  if (!confirmed) {
    console.log('已取消重置。');
    return;
  }
  
  doResetMemory(paths);
}

function doResetMemory(paths: ResolvedPaths): void {
  console.log('🔄 正在清空记忆...');
  
  if (fs.existsSync(paths.memoryDir)) {
    const count = removeDirContents(paths.memoryDir);
    console.log(`   ✅ 已删除 ${count} 个记忆文件`);
  } else {
    console.log(`   ℹ️  记忆目录不存在，跳过`);
  }
}

/**
 * 初始化 Kobot 并执行回调（供 CLI 命令复用）
 */
async function runWithBot(fn: (bot: Kobot) => Promise<void>): Promise<void> {
  process.env.KOBOT_LOG_CONSOLE = 'false';
  createLogger({ console_enabled: false });
  loadEnvFile();

  if (!hasAnyApiKey()) {
    console.log('错误: 未配置 API Key。请先运行 "kobot start" 进行配置');
    process.exit(1);
  }

  try {
    const bot = await Kobot.fromConfig();
    await fn(bot);
    await bot.close();
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}

async function replaySession(sessionKey: string): Promise<void> {
  console.log('正在启动 Kobot...');

  // 在机器人初始化前禁用 CLI 模式下的控制台日志
  process.env.KOBOT_LOG_CONSOLE = 'false';
  createLogger({ console_enabled: false });

  // 从 ~/.kobot/.env 加载持久化的环境变量
  loadEnvFile();

  // 如果未配置 API Key，运行交互式设置向导
  let selectedModel: string | undefined;
  if (!hasAnyApiKey()) {
    const setupResult = await runSetupWizard();
    selectedModel = setupResult.model;
  }

  try {
    const bot = await Kobot.fromConfig({ model: selectedModel });

    console.log('✅ Kobot 初始化成功');
    console.log(`   模型: ${bot.config_.agents.defaults.model}\n`);

    console.log(`开始回放会话：${sessionKey}`);
    console.log('----------------------------------------');

    const result = await bot.replaySession(sessionKey,
      // 每轮开始前显示进度
      (current, total, message) => {
        console.log(`[${current}/${total}] 正在回放：${message.slice(0, 80)}${message.length > 80 ? '...' : ''}`);
      },
      // 每轮完成后立即显示结果
      (current, total, turn) => {
        if (turn.error) {
          console.log(`  ❌ 错误：${turn.error}`);
        } else if (turn.response) {
          const preview = turn.response.slice(0, 300);
          console.log(`  🤖 响应：${preview}${turn.response.length > 300 ? '...' : ''}`);
        } else {
          console.log('  ⚠️  无响应');
        }
        console.log('');
      },
    );

    console.log(`共 ${result.userMessageCount} 条用户消息，用时 ${(result.totalDurationMs / 1000).toFixed(1)}s`);

    if (result.totalErrors > 0) {
      console.log(`💥 总计 ${result.totalErrors}/${result.userMessageCount} 轮出错`);
    } else {
      console.log('✅ 全部回放成功，未出现错误');
    }
  } catch (err) {
    console.error(`\n❌ 回放失败：${(err as Error).message}`);
    process.exit(1);
  }
}

async function startBot(): Promise<void> {
  console.log('正在启动 Kobot...');
  
  // 在机器人初始化前禁用 CLI 模式下的控制台日志
  process.env.KOBOT_LOG_CONSOLE = 'false';
  createLogger({ console_enabled: false });

  // 从 ~/.kobot/.env 加载持久化的环境变量（shell 环境变量优先）
  loadEnvFile();

  // 如果未配置 API Key，运行交互式设置向导
  let selectedModel: string | undefined;
  if (!hasAnyApiKey()) {
    const setupResult = await runSetupWizard();
    selectedModel = setupResult.model;
  } else {
    // 也支持 KOBOT_MODEL 环境变量
    if (process.env.KOBOT_MODEL) {
      selectedModel = process.env.KOBOT_MODEL;
    }
  }
  
  try {
    const bot = await Kobot.fromConfig({ model: selectedModel });
    
    console.log('✅ Kobot 初始化成功');
    console.log(`   模型: ${bot.config_.agents.defaults.model}`);
    console.log(`   工具: ${bot.tools.length} 个可用`);

    // 如果通过环境变量配置了飞书，则启动飞书渠道
    const feishuAppId = process.env.FEISHU_APP_ID;
    const feishuAppSecret = process.env.FEISHU_APP_SECRET;
    if (feishuAppId && feishuAppSecret) {
      const feishuChannel = new FeishuChannel({
        id: 'feishu',
        name: 'Feishu',
        enabled: true,
        appId: feishuAppId,
        appSecret: feishuAppSecret,
        port: parseInt(process.env.FEISHU_PORT || '3000', 10),
        path: process.env.FEISHU_PATH || '/webhook/event',
      });
      await feishuChannel.start(bot);
    }
    
    const cliChannel = new CLIChannel({
      id: 'cli',
      name: 'CLI',
      enabled: true,
      historySize: 100,
      prompt: 'kobot> ',
    });

    await cliChannel.start(bot);
  } catch (err) {
    console.error('❌ 启动 kobot 时出错:', (err as Error).message);
    console.log('\n💡 提示:');
    console.log('   - 请确保已在环境变量中配置 API Key');
    console.log('   - 例如: OPENAI_API_KEY, ANTHROPIC_API_KEY, GROQ_API_KEY 等');
    console.log('   - 检查配置文件: ~/.kobot/config.yaml');
    process.exit(1);
  }
}

program.parseAsync(process.argv).catch((err) => {
  console.error('致命错误:', err);
  process.exit(1);
});
