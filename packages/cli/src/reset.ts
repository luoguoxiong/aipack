/**
 * packages/cli/src/reset.ts
 *
 * 重置数据：all / config / logs / sessions / memory（带确认提示）。
 * 对齐 src/cli.ts 的 reset 命令组，路径基于 aipack 配置解析。
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { getConfigDir, loadConfig } from './config';

export interface ResolvedPaths {
  configDir: string;
  configPath: string;
  envPath: string;
  logsDir: string;
  sessionsDir: string;
  memoryDir: string;
}

export async function resolvePaths(): Promise<ResolvedPaths> {
  const configDir = getConfigDir();
  const config = await loadConfig();
  const workspace = config.workspace;
  return {
    configDir,
    configPath: path.join(configDir, 'config.json'),
    envPath: path.join(configDir, '.env'),
    logsDir: path.join(workspace, 'logs'),
    sessionsDir: config.sessions.baseDir,
    memoryDir: path.join(workspace, 'memory'),
  };
}

export function confirmAction(
  message: string,
  skipConfirm: boolean,
): Promise<boolean> {
  if (skipConfirm) return Promise.resolve(true);

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

function removeDirContents(dirPath: string): number {
  if (!fs.existsSync(dirPath)) return 0;

  let count = 0;
  for (const entry of fs.readdirSync(dirPath)) {
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

// ─── reset all ─────────────────────────────────────────────────────

export async function resetAll(skipConfirm: boolean): Promise<void> {
  const paths = await resolvePaths();

  const confirmed = await confirmAction(
    '⚠️  这将重置所有数据，包括配置、日志、会话和记忆。确定继续吗？',
    skipConfirm,
  );
  if (!confirmed) {
    console.log('已取消重置。');
    return;
  }

  console.log('🔄 正在重置所有 aipack 数据...');
  doResetConfig(paths);
  doResetLogs(paths);
  doResetSessions(paths);
  doResetMemory(paths);

  console.log('\n✅ 所有数据重置完成。');
  console.log('   运行 "aipack chat" 重新开始。');
}

// ─── reset config ──────────────────────────────────────────────────

export async function resetConfig(skipConfirm: boolean): Promise<void> {
  const paths = await resolvePaths();

  const confirmed = await confirmAction(
    `⚠️  这将删除用户级配置文件与 .env。\n   配置文件: ${paths.configPath}\n   .env 文件: ${paths.envPath}\n   项目级 aipack.config.json 不受影响。\n   确定继续吗？`,
    skipConfirm,
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
    console.log(`   ✅ 已删除 config.json`);
  } else {
    console.log(`   ℹ️  config.json 不存在，跳过`);
  }

  if (fs.existsSync(paths.envPath)) {
    fs.unlinkSync(paths.envPath);
    console.log(`   ✅ 已删除 .env`);
  } else {
    console.log(`   ℹ️  .env 不存在，跳过`);
  }

  // aipack 依赖默认值运行，无需重新生成配置
  console.log('   ✅ 将使用默认配置');
}

// ─── reset logs ────────────────────────────────────────────────────

export async function resetLogs(skipConfirm: boolean): Promise<void> {
  const paths = await resolvePaths();

  const confirmed = await confirmAction(
    `⚠️  这将清空以下目录中的所有日志文件:\n   ${paths.logsDir}\n   确定继续吗？`,
    skipConfirm,
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

// ─── reset sessions ────────────────────────────────────────────────

export async function resetSessions(skipConfirm: boolean): Promise<void> {
  const paths = await resolvePaths();

  const confirmed = await confirmAction(
    `⚠️  这将删除以下目录中的所有会话数据:\n   ${paths.sessionsDir}\n   确定继续吗？`,
    skipConfirm,
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

// ─── reset memory ──────────────────────────────────────────────────

export async function resetMemory(skipConfirm: boolean): Promise<void> {
  const paths = await resolvePaths();

  const confirmed = await confirmAction(
    `⚠️  这将删除以下目录中的所有记忆数据:\n   ${paths.memoryDir}\n   确定继续吗？`,
    skipConfirm,
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
