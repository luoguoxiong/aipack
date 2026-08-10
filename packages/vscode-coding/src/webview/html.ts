/**
 * Webview HTML 模板生成。
 *
 * CSP：default-src 'none'；img-src 允许 cspSource + https；script-src 仅 nonce；style-src 允许 cspSource + unsafe-inline（VSCode 主题变量注入需要）。
 * 引用 media/reset.css 与 media/main.js（带 nonce）。
 */

import * as vscode from 'vscode';

export function getWebviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
): string {
  const nonce = getNonce();

  const mediaUri = (name: string) =>
    webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', name));
  const resetCss = mediaUri('reset.css');
  const mainJs = mediaUri('main.js');

  return /* html */ `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none';
                 img-src ${webview.cspSource} https:;
                 script-src 'nonce-${nonce}';
                 style-src ${webview.cspSource} 'unsafe-inline';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Aipack Coding</title>
  <link rel="stylesheet" href="${resetCss}" />
  <style>
    /* 主题适配 + 布局 */
    :root { color-scheme: light dark; }
    body {
      display: flex;
      flex-direction: column;
      height: 100vh;
      margin: 0;
      padding: 0;
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      font-family: var(--vscode-font-family, system-ui);
      font-size: var(--vscode-font-size, 13px);
    }
    #messages {
      flex: 1;
      overflow-y: auto;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .msg { max-width: 100%; word-wrap: break-word; }
    .msg.user {
      align-self: flex-end;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      padding: 8px 12px;
      border-radius: 10px;
      max-width: 80%;
      white-space: pre-wrap;
    }
    .msg.assistant {
      align-self: flex-start;
      background: var(--vscode-editor-inactive-selection-background);
      padding: 8px 12px;
      border-radius: 10px;
      max-width: 90%;
      white-space: pre-wrap;
    }
    .msg.assistant pre {
      background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.12));
      padding: 8px;
      border-radius: 6px;
      overflow-x: auto;
      margin: 6px 0;
      white-space: pre;
    }
    .msg.assistant code {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.92em;
    }
    .msg.assistant p { margin: 4px 0; }
    .thinking {
      align-self: flex-start;
      max-width: 90%;
      opacity: 0.85;
      font-size: 0.92em;
    }
    .thinking summary {
      cursor: pointer;
      color: var(--vscode-descriptionForeground);
      padding: 2px 0;
    }
    .thinking .body {
      padding: 6px 10px;
      white-space: pre-wrap;
      color: var(--vscode-descriptionForeground);
    }
    .tool-card {
      align-self: flex-start;
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      border-radius: 6px;
      border-left: 3px solid var(--vscode-editorWarning-foreground);
      background: var(--vscode-editor-inactive-selection-background);
      font-size: 0.9em;
    }
    .tool-card.ok { border-left-color: var(--vscode-testing-iconPassed, #3fb950); }
    .tool-card.error { border-left-color: var(--vscode-testing-iconFailed, #f85149); }
    .tool-card .icon::before { content: '⚙'; margin-right: 4px; }
    .tool-card.ok .icon::before { content: '✓'; color: var(--vscode-testing-iconPassed, #3fb950); }
    .tool-card.error .icon::before { content: '✗'; color: var(--vscode-testing-iconFailed, #f85149); }
    #status {
      padding: 2px 12px;
      min-height: 18px;
      color: var(--vscode-descriptionForeground);
      font-size: 0.85em;
    }
    .composer {
      display: flex;
      gap: 6px;
      padding: 10px;
      border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2));
    }
    #input {
      flex: 1;
      resize: none;
      min-height: 48px;
      max-height: 160px;
      padding: 8px;
      border: 1px solid var(--vscode-input-border, transparent);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border-radius: 6px;
      font-family: inherit;
      font-size: inherit;
    }
    button {
      padding: 6px 14px;
      border: none;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-radius: 4px;
      cursor: pointer;
      font-size: 0.95em;
    }
    button:disabled { opacity: 0.5; cursor: default; }
    button.secondary {
      background: var(--vscode-button-secondaryBackground, transparent);
      color: var(--vscode-button-secondaryForeground, inherit);
      border: 1px solid var(--vscode-button-border, rgba(128,128,128,0.3));
    }
  </style>
</head>
<body>
  <div id="messages"></div>
  <div id="status"></div>
  <div class="composer">
    <textarea id="input" placeholder="问点什么... (Enter 发送 / Shift+Enter 换行)"></textarea>
    <button id="send">发送</button>
    <button id="stop" class="secondary" disabled>停止</button>
  </div>
  <script nonce="${nonce}" src="${mainJs}"></script>
</body>
</html>`;
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}
