/**
 * 命令注册：openChat / stop / clearHistory。
 *
 * openChat 聚焦侧边栏 webview view（由 CodingChatView 提供）；
 * stop / clearHistory 委托给当前 CodingChatView 实例。
 */

import * as vscode from 'vscode';
import type { AgentService } from './agent';
import type { CodingChatView } from './webview/panel';

export function registerCommands(
  ctx: vscode.ExtensionContext,
  _agent: AgentService,
  chatView: CodingChatView,
): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand('aipack.coding.openChat', async () => {
      if (!vscode.workspace.workspaceFolders?.length) {
        vscode.window.showWarningMessage(
          '请先打开一个文件夹再使用 Aipack Coding。',
        );
        return;
      }
      chatView.show();
    }),

    vscode.commands.registerCommand('aipack.coding.stop', async () => {
      await chatView.stop();
    }),

    vscode.commands.registerCommand('aipack.coding.clearHistory', async () => {
      await chatView.clear();
      vscode.window.showInformationMessage('已清空当前会话历史。');
    }),
  );
}
