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
  .description('Kobot - A lightweight personal AI assistant')
  .version('0.0.2');

program
  .command('start', { isDefault: true })
  .description('Start Kobot interactive CLI (default command)')
  .action(async () => {
    await startBot();
  });

const resetCmd = program
  .command('reset')
  .description('Reset Kobot data - config, logs, sessions, etc.');

resetCmd
  .command('all')
  .description('Reset everything (config, logs, sessions, memory)')
  .option('-y, --yes', 'Skip confirmation prompt')
  .action(async (options) => {
    await resetAll(options.yes);
  });

resetCmd
  .command('config')
  .description('Reset config to defaults')
  .option('-y, --yes', 'Skip confirmation prompt')
  .action(async (options) => {
    await resetConfig(options.yes);
  });

resetCmd
  .command('logs')
  .description('Clear all log files')
  .option('-y, --yes', 'Skip confirmation prompt')
  .action(async (options) => {
    await resetLogs(options.yes);
  });

resetCmd
  .command('sessions')
  .description('Clear all session data')
  .option('-y, --yes', 'Skip confirmation prompt')
  .action(async (options) => {
    await resetSessions(options.yes);
  });

resetCmd
  .command('memory')
  .description('Clear all memory data')
  .option('-y, --yes', 'Skip confirmation prompt')
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
    '⚠️  This will reset ALL data including config, logs, sessions, and memory. Continue?',
    skipConfirm
  );
  
  if (!confirmed) {
    console.log('Reset cancelled.');
    return;
  }
  
  console.log('🔄 Resetting all Kobot data...');
  
  doResetConfig(paths);
  doResetLogs(paths);
  doResetSessions(paths);
  doResetMemory(paths);
  
  console.log('\n✅ All data reset complete.');
  console.log('   Run "kobot start" to reconfigure and start Kobot.');
}

async function resetConfig(skipConfirm: boolean): Promise<void> {
  const paths = await resolvePaths();
  
  const confirmed = await confirmAction(
    `⚠️  This will reset config to defaults and remove .env file.\n   Config: ${paths.configPath}\n   .env: ${paths.envPath}\n   Continue?`,
    skipConfirm
  );
  
  if (!confirmed) {
    console.log('Reset cancelled.');
    return;
  }
  
  doResetConfig(paths);
}

function doResetConfig(paths: ResolvedPaths): void {
  console.log('🔄 Resetting config...');
  
  if (fs.existsSync(paths.configPath)) {
    fs.unlinkSync(paths.configPath);
    console.log(`   ✅ Removed config.yaml`);
  } else {
    console.log(`   ℹ️  config.yaml not found, skipping`);
  }
  
  if (fs.existsSync(paths.envPath)) {
    fs.unlinkSync(paths.envPath);
    console.log(`   ✅ Removed .env`);
  } else {
    console.log(`   ℹ️  .env not found, skipping`);
  }
  
  // 重新生成默认配置 - 注意：默认配置中 workspace 是 ~/.kobot
  // 但 saveConfig 会保存到 paths.configPath 位置
  const config = defaultConfig();
  config.sessions = { storage: 'file', storage_path: 'sessions' };
  saveConfig(config, paths.configPath).then(() => {
    console.log(`   ✅ Generated default config`);
  }).catch(() => {
    console.log(`   ⚠️  Failed to generate default config`);
  });
}

async function resetLogs(skipConfirm: boolean): Promise<void> {
  const paths = await resolvePaths();
  
  const confirmed = await confirmAction(
    `⚠️  This will clear all log files in:\n   ${paths.logsDir}\n   Continue?`,
    skipConfirm
  );
  
  if (!confirmed) {
    console.log('Reset cancelled.');
    return;
  }
  
  doResetLogs(paths);
}

function doResetLogs(paths: ResolvedPaths): void {
  console.log('🔄 Clearing logs...');
  
  if (fs.existsSync(paths.logsDir)) {
    const count = removeDirContents(paths.logsDir);
    console.log(`   ✅ Removed ${count} log file(s)`);
  } else {
    console.log(`   ℹ️  Logs directory not found, skipping`);
  }
}

async function resetSessions(skipConfirm: boolean): Promise<void> {
  const paths = await resolvePaths();
  
  const confirmed = await confirmAction(
    `⚠️  This will delete ALL session data in:\n   ${paths.sessionsDir}\n   Continue?`,
    skipConfirm
  );
  
  if (!confirmed) {
    console.log('Reset cancelled.');
    return;
  }
  
  doResetSessions(paths);
}

function doResetSessions(paths: ResolvedPaths): void {
  console.log('🔄 Clearing sessions...');
  
  if (fs.existsSync(paths.sessionsDir)) {
    const count = removeDirContents(paths.sessionsDir);
    console.log(`   ✅ Removed ${count} session file(s)`);
  } else {
    console.log(`   ℹ️  Sessions directory not found, skipping`);
  }
}

async function resetMemory(skipConfirm: boolean): Promise<void> {
  const paths = await resolvePaths();
  
  const confirmed = await confirmAction(
    `⚠️  This will delete ALL memory data in:\n   ${paths.memoryDir}\n   Continue?`,
    skipConfirm
  );
  
  if (!confirmed) {
    console.log('Reset cancelled.');
    return;
  }
  
  doResetMemory(paths);
}

function doResetMemory(paths: ResolvedPaths): void {
  console.log('🔄 Clearing memory...');
  
  if (fs.existsSync(paths.memoryDir)) {
    const count = removeDirContents(paths.memoryDir);
    console.log(`   ✅ Removed ${count} memory file(s)`);
  } else {
    console.log(`   ℹ️  Memory directory not found, skipping`);
  }
}

async function startBot(): Promise<void> {
  console.log('Starting Kobot...');
  
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
    
    console.log('✅ Kobot initialized successfully');
    console.log(`   Model: ${bot.config_.agents.defaults.model}`);
    console.log(`   Tools: ${bot.tools.length} available`);

    // Start Feishu channel if configured via environment variables
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
    console.error('❌ Error starting kobot:', (err as Error).message);
    console.log('\n💡 Tips:');
    console.log('   - Make sure you have configured API keys in environment variables');
    console.log('   - OPENAI_API_KEY, ANTHROPIC_API_KEY, GROQ_API_KEY, etc.');
    console.log('   - Check your config file at ~/.kobot/config.yaml');
    process.exit(1);
  }
}

program.parseAsync(process.argv).catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
