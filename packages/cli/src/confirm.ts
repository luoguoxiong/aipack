/**
 * 终端交互式选择器 + 工具权限确认
 *
 * 替代 y/N 输入式确认：↑/↓（或 j/k）选择，回车确认，Esc/q/Ctrl+C 取消。
 * 数字键 1-9 直选。非 TTY 环境返回取消（保守拒绝）。
 */
import chalk from 'chalk';
import type { PermissionRequest } from '@aipack-ai/agent';
import { select } from './select.js';

export { select };
export type { SelectOption } from './select.js';

// ─── 危险命令检测（bash 工具）────────────────────────────────────

/** [模式, 说明]：命中的 shell 命令即使默认放行模式也需人工确认 */
const DANGEROUS_PATTERNS: Array<[RegExp, string]> = [
  // 递归删除根/家目录（rm -rf /、rm -rf ~、rm -rf /* 等；正常子目录不受影响）
  [/rm\s+[^;|&]*[rf][^;|&]*\s+(\/|~|\$HOME)(\/?\*|\s|$)/, '递归删除根/家目录'],
  [/\bsudo(\s|$)/, '提权执行'],
  [/\bmkfs(\s|\.)/, '格式化磁盘'],
  [/\bdd\s+[^;|]*of=\/dev\//, '写入磁盘设备'],
  [/>\s*\/dev\/(sd|disk|nvme)/, '覆写磁盘设备'],
  [/(curl|wget)[^|;]*\|\s*(sudo\s+)?(ba|z)?sh/, '管道执行远程脚本'],
  [/chmod\s+-R\s+777\s+\/(\s|$)/, '根目录开放全部权限'],
  [/\b(shutdown|reboot|halt|poweroff)\b/, '关机/重启'],
  [/:\s*\(\)\s*\{[^}]*\}\s*;\s*:/, 'fork 炸弹'],
];

/** 返回危险原因；非危险命令返回 null */
export function isDangerousCommand(command: string): string | null {
  for (const [pattern, reason] of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) return reason;
  }
  return null;
}

// ─── 工具权限确认（三选项 + 会话级记忆）──────────────────────────

export type ToolConfirmChoice = 'once' | 'always' | 'deny';

/** 从工具参数提取简短摘要（bash 显示命令，文件工具显示路径） */
function summarizeArgs(req: PermissionRequest): string {
  const args = req.args as Record<string, unknown> | undefined;
  if (!args || typeof args !== 'object') return '';
  const cmd = args.command;
  if (typeof cmd === 'string') return cmd.length > 60 ? `${cmd.slice(0, 60)}…` : cmd;
  const file = args.file ?? args.path;
  if (typeof file === 'string') return file;
  return '';
}

export interface ToolConfirmHandlerOptions {
  /**
   * 自动放行低风险操作（默认 true）：
   * - bash 的非危险命令静默放行，仅危险命令弹选择器
   * - false（--safe）时全部弹选择器
   */
  autoApproveSafe?: boolean;
}

export function createToolConfirmHandler(
  options: ToolConfirmHandlerOptions = {},
): (req: PermissionRequest) => Promise<boolean> {
  const autoApproveSafe = options.autoApproveSafe ?? true;
  /** 会话级"总是允许"记忆：key = 能力组合或工具名 */
  const alwaysAllowed = new Set<string>();

  return async (req: PermissionRequest): Promise<boolean> => {
    if (!process.stdin.isTTY) return false;

    const key = req.permissions.length > 0
      ? [...req.permissions].sort().join(',')
      : `tool:${req.toolName}`;
    if (alwaysAllowed.has(key)) return true;

    const args = req.args as Record<string, unknown> | undefined;
    const command = typeof args?.command === 'string' ? args.command : '';

    // 默认模式：bash 非危险命令自动放行（不打断用户）
    if (autoApproveSafe && command && !isDangerousCommand(command)) {
      return true;
    }

    const dangerReason = command ? isDangerousCommand(command) : null;
    const summary = command || summarizeArgs(req);
    const question = dangerReason
      ? `危险命令（${dangerReason}）：${summary}`
      : summary
        ? `允许执行 ${req.toolName}：${summary}`
        : `允许执行 ${req.toolName}`;

    const choice = await select<ToolConfirmChoice>(question, [
      { label: '允许', value: 'once' },
      { label: '总是允许（本会话）', value: 'always' },
      { label: '拒绝', value: 'deny' },
    ]);

    if (choice === 'always') {
      alwaysAllowed.add(key);
      return true;
    }
    return choice === 'once';
  };
}
