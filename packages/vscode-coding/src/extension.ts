/**
 * VSCode 扩展入口。
 *
 * activate：创建 AgentService（懒初始化）+ 注册命令 + 监听配置变更（重建 agent）
 * deactivate：关闭 agent 释放资源
 *
 * agent 的真正创建发生在首次 openChat → streamRun → getAgent，避免无 API Key 时启动报错。
 */

import * as vscode from 'vscode';
import { AgentService } from './agent';
import { registerCommands } from './commands';
import { CodingChatView } from './webview/panel';

let agentService: AgentService | undefined;

export async function activate(
  ctx: vscode.ExtensionContext,
): Promise<void> {
  console.log('[aipack] activate');
  agentService = new AgentService(ctx);

  // 侧边栏 webview view：package.json 声明的 aipack.coding.chatView
  // VSCode 首次展开该 view 时回调 resolveWebviewView 注入聊天 UI
  const chatView = new CodingChatView(ctx, agentService);
  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider(CodingChatView.viewType, chatView, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  registerCommands(ctx, agentService, chatView);

  // 配置变更：provider/model/apiKey/memory 变化时，标记 agent 需重建（保留 allowedAlways）
  ctx.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('aipack')) {
        agentService?.invalidate();
      }
    }),
  );
}

export async function deactivate(): Promise<void> {
  await agentService?.dispose();
  agentService = undefined;
}
