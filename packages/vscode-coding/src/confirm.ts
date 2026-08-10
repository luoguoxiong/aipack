/**
 * 命令确认 QuickPick 适配器。
 *
 * 把 aipack-coding 的 PermissionManager.confirmFn 接到 VSCode QuickPick：
 * 变更性命令（git commit / npm install 等）执行前弹出三选项，
 * 返回值对齐 ConfirmResult = true | false | 'allow-always'。
 *
 * 返回 'allow-always' 时，PermissionManager 会自动把该条命令（整条归一化命令）
 * 加入 allowedAlways 集合（见 aipack-coding/src/permission.ts:90），扩展侧无需手动管理。
 */

import * as vscode from 'vscode';
import type { ConfirmContext, ConfirmResult } from '@aipack/coding';

interface ConfirmPickItem extends vscode.QuickPickItem {
  action: 'once' | 'always' | 'deny';
}

/**
 * 创建一个 confirmFn，供 createCodingAgent({ permission: { confirmFn } }) 使用。
 * 每次调用都弹出一个 QuickPick；ESC / 失焦视为拒绝（ignoreFocusOut 防误关）。
 */
export function createQuickPickConfirmFn(): (
  ctx: ConfirmContext,
) => Promise<ConfirmResult> {
  return async (ctx: ConfirmContext): Promise<ConfirmResult> => {
    const items: ConfirmPickItem[] = [
      {
        label: '$(check) 本次允许',
        description: '允许执行该命令一次',
        action: 'once',
      },
      {
        label: '$(sync) 始终允许',
        description: '该命令后续免确认（加入 allow-always 集合）',
        action: 'always',
      },
      {
        label: '$(close) 拒绝',
        description: '拒绝执行',
        action: 'deny',
      },
    ];

    const pick = await vscode.window.showQuickPick(items, {
      title: 'Aipack 请求执行命令',
      placeHolder: ctx.command,
      ignoreFocusOut: true, // 失焦不关闭，避免误操作导致命令被拒
    });

    if (!pick) return false; // ESC 视为拒绝
    if (pick.action === 'once') return true;
    if (pick.action === 'always') return 'allow-always';
    return false;
  };
}
