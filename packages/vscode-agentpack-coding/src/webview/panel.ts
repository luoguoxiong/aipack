/**
 * CodingChatView —— 侧边栏 Webview View（实现 WebviewViewProvider）。
 *
 * package.json 在 activitybar 声明了 viewsContainers + views（type: "webview"），
 * VSCode 在用户首次打开该 view 时调用 resolveWebviewView，由本类注入 HTML 与消息桥接。
 *
 * 职责：
 * 1. resolveWebviewView：注入 HTML（含 CSP nonce）+ 注册 onDidReceiveMessage
 * 2. 接收前端 WebviewInbound：ready（回灌历史）/ send（流式运行）/ stop / clear
 * 3. 订阅 agent.streamRun() 的 ResultChunk，翻译成 WebviewOutbound postMessage
 * 4. show()：聚焦 view（供 openChat 命令）
 */

import * as vscode from 'vscode';
import type { ResultChunk } from 'agentpack';
import type { AgentService } from '../agent';
import { getWebviewHtml } from './html';
import type { WebviewInbound, WebviewOutbound } from '../types';
import { serializeMessages } from '../types';

export class CodingChatView implements vscode.WebviewViewProvider {
  public static readonly viewType = 'agentpack.coding.chatView';

  private view?: vscode.WebviewView;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly sessionKey: string;
  private running = false;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly agent: AgentService,
  ) {
    this.sessionKey = `vscode-coding-${Date.now().toString(36)}`;
  }

  /** VSCode 首次解析 view 时调用：注入 HTML 与消息桥接 */
  resolveWebviewView(
    view: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
  ): void {
    console.log('[agentpack] resolveWebviewView');
    this.view = view;

    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, 'media')],
    };
    view.webview.html = getWebviewHtml(view.webview, this.ctx.extensionUri);

    view.webview.onDidReceiveMessage(
      (msg: WebviewInbound) => this.handleMessage(msg),
      undefined,
      this.disposables,
    );

    // view 被关闭时清掉引用（retainContextWhenHidden 仍会保留 webview 状态）
    view.onDidDispose(() => {
      this.view = undefined;
    });
  }

  /** 聚焦并显示 view（供 openChat 命令调用） */
  show(): void {
    vscode.commands.executeCommand(`${CodingChatView.viewType}.focus`);
  }

  /** 停止当前会话（供 stop 命令调用） */
  public async stop(): Promise<void> {
    if (!this.running) return;
    try {
      await this.agent.stop(this.sessionKey);
    } catch {
      // 忽略
    }
    this.setRunning(false);
  }

  /** 清空历史（供 clearHistory 命令调用） */
  public async clear(): Promise<void> {
    try {
      await this.agent.clearHistory(this.sessionKey);
    } catch {
      // 忽略
    }
    this.post({ type: 'historyCleared' });
  }

  private async handleMessage(msg: WebviewInbound): Promise<void> {
    console.log('[agentpack] msg:', msg.type);
    switch (msg.type) {
      case 'ready':
        await this.sendHistory();
        break;
      case 'send':
        await this.runStream(msg.text);
        break;
      case 'stop':
        await this.stop();
        break;
      case 'clear':
        await this.clear();
        break;
    }
  }

  /** 回灌历史消息 */
  private async sendHistory(): Promise<void> {
    try {
      const messages = await this.agent.getHistory(this.sessionKey);
      if (messages.length > 0) {
        this.post({ type: 'history', messages: serializeMessages(messages) });
      }
    } catch {
      // 首次无 agent 时忽略
    }
  }

  /** 流式运行：订阅 stream 并转发 chunk */
  private async runStream(text: string): Promise<void> {
    if (this.running) return; // 防并发
    console.log('[agentpack] runStream start:', text.slice(0, 30));
    this.post({ type: 'userMessage', text });
    this.setRunning(true);

    try {
      console.log('[agentpack] stream loop starting');
      for await (const chunk of this.agent.streamRun(text, this.sessionKey)) {
        console.log('[agentpack] chunk:', chunk.type);
        this.forwardChunk(chunk);
      }
      console.log('[agentpack] stream loop done');
    } catch (err) {
      console.error('[agentpack] stream error:', err);
      this.post({ type: 'error', message: (err as Error).message });
    } finally {
      this.setRunning(false);
      this.post({ type: 'done' });
    }
  }

  /** 把 ResultChunk 翻译成 WebviewOutbound */
  private forwardChunk(c: ResultChunk): void {
    switch (c.type) {
      case 'text':
        this.post({ type: 'chunk', chunkType: 'text', content: c.content ?? '' });
        break;
      case 'thinking':
        this.post({ type: 'chunk', chunkType: 'thinking', content: c.content ?? '' });
        break;
      case 'tool_start':
        this.post({
          type: 'toolStart',
          toolName: c.toolName ?? 'tool',
          toolCallId: c.toolCallId,
        });
        break;
      case 'tool_end':
        this.post({
          type: 'toolEnd',
          toolName: c.toolName ?? 'tool',
          toolCallId: c.toolCallId,
          isError: !!c.isError,
        });
        break;
      case 'error':
        this.post({ type: 'error', message: c.content ?? 'unknown error' });
        break;
      case 'done':
        this.post({ type: 'done' });
        break;
    }
  }

  private setRunning(r: boolean): void {
    this.running = r;
    this.post({ type: 'status', running: r });
  }

  private post(msg: WebviewOutbound): void {
    this.view?.webview.postMessage(msg);
  }
}
