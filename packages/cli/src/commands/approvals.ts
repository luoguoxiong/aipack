/**
 * approvals 子命令：跨进程查看/结算审批单（基于 FileApprovalStore）。
 *
 * 语义：审批单由启用 approvals 的运行进程创建（pending 时落盘）。
 * 本命令直接经 store 结算文件（同进程内存等待方无法被唤醒——跨进程审批
 * 面板场景；交互会话内请用 /approve、/deny）。
 */
import path from 'node:path';
import chalk from 'chalk';
import { FileApprovalStore, createApprovalManager } from '@aipack-ai/agent';
import type { StoredApproval } from '@aipack-ai/agent';
import { defaultConfigDir } from '../version.js';

function createStore(): FileApprovalStore {
  return new FileApprovalStore({
    baseDir: path.join(defaultConfigDir(), 'approvals'),
  });
}

export async function handleApprovalsCommand(args: string[]): Promise<number> {
  const [sub, ...rest] = args;

  if (!sub || sub === 'help' || sub === '--help') {
    printUsage();
    return 0;
  }

  const store = createStore();

  if (sub === 'list') {
    const pending = await store.load();
    if (pending.length === 0) {
      console.log(chalk.dim('（无未决审批单）'));
      return 0;
    }
    for (const p of pending) {
      printApproval(p);
    }
    return 0;
  }

  if (sub === 'approve' || sub === 'deny') {
    const id = rest[0];
    if (!id) {
      console.error(chalk.red(`用法: aipack approvals ${sub} <id>`));
      return 1;
    }
    // 经 ApprovalManager 走 restore + resolve，复用统一结算/审计路径
    const manager = createApprovalManager({ store });
    await manager.restore();
    const ok = manager.resolve(id, sub === 'approve');
    manager.close();
    if (!ok) {
      console.error(chalk.yellow(`审批单 ${id} 不存在或已结算`));
      return 1;
    }
    console.log(chalk.green(`已${sub === 'approve' ? '批准' : '驳回'} ${id}`));
    return 0;
  }

  printUsage();
  console.error(chalk.red(`未知子命令: ${sub}`));
  return 1;
}

function printApproval(p: StoredApproval): void {
  const created = new Date(p.createdAt).toLocaleString();
  const expires = p.expiresAt ? chalk.dim(` 过期 ${new Date(p.expiresAt).toLocaleTimeString()}`) : '';
  console.log(`${chalk.cyan(p.id)}  ${chalk.bold(p.toolName)}  ${chalk.dim(created)}${expires}`);
  if (p.permissions.length > 0) {
    console.log(chalk.dim(`  能力: ${p.permissions.join(', ')}`));
  }
  const argsStr = JSON.stringify(p.args);
  if (argsStr && argsStr !== '{}') {
    console.log(chalk.dim(`  参数: ${argsStr.length > 120 ? `${argsStr.slice(0, 120)}…` : argsStr}`));
  }
}

function printUsage(): void {
  console.log(`用法:
  aipack approvals list              列出未决审批单
  aipack approvals approve <id>      批准
  aipack approvals deny <id>         驳回`);
}
