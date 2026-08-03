// Webview 前端入口（原生 JS，被 <script nonce> 引用，不走 esbuild bundle）。
// 职责：acquireVsCodeApi + postMessage 收发 + 流式增量渲染 + 极简 Markdown。

// @ts-nocheck — Webview 运行时无 TS 类型；保持原生 JS 语义
const vscode = acquireVsCodeApi();

// ─── 状态 ──────────────────────────────────────────────────────────
let running = false;
let pendingText = ''; // 当前 assistant 气泡累积的文本（流式追加）
let currentAssistantEl = null; // 当前正在流式追加的 assistant 气泡
let pendingThinking = ''; // 当前 thinking 块累积文本
let currentThinkingEl = null;

const messagesEl = document.getElementById('messages');
const statusEl = document.getElementById('status');
const inputEl = document.getElementById('input');
const sendBtn = document.getElementById('send');
const stopBtn = document.getElementById('stop');

// ─── 极简 Markdown 渲染（先 HTML 转义防 XSS，再格式化）──────────────
function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderMarkdown(text) {
  // 1. 转义
  let s = escapeHtml(text);

  // 2. 代码块围栏 ```lang\n...\n``` → <pre><code>
  //    用占位符避免行内代码处理干扰
  const codeBlocks = [];
  s = s.replace(/```([a-zA-Z0-9_-]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const placeholder = `\u0000CODEBLOCK${codeBlocks.length}\u0000`;
    codeBlocks.push(`<pre><code>${code.replace(/\u0000CODEBLOCK\d+\u0000/g, '')}</code></pre>`);
    return placeholder;
  });

  // 3. 行内代码 `...` → <code>...</code>
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');

  // 4. 粗体 **...** → <strong>
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  // 5. 段落：双换行分段，单换行转 <br>
  const paragraphs = s.split(/\n{2,}/);
  s = paragraphs
    .map((p) => {
      const trimmed = p.trim();
      if (!trimmed) return '';
      // 占位符所在的段不包 <p>（代码块独占一段）
      if (/^\u0000CODEBLOCK\d+\u0000$/.test(trimmed)) return trimmed;
      return '<p>' + trimmed.replace(/\n/g, '<br>') + '</p>';
    })
    .join('\n');

  // 6. 还原代码块占位符
  s = s.replace(/\u0000CODEBLOCK(\d+)\u0000/g, (_, i) => codeBlocks[Number(i)] || '');

  return s;
}

// ─── DOM 渲染 ──────────────────────────────────────────────────────
function newAssistantBubble() {
  pendingText = '';
  const el = document.createElement('div');
  el.className = 'msg assistant';
  messagesEl.appendChild(el);
  currentAssistantEl = el;
  return el;
}

function appendTextChunk(content) {
  pendingText += content;
  if (!currentAssistantEl) newAssistantBubble();
  currentAssistantEl.innerHTML = renderMarkdown(pendingText);
  scrollToBottom();
}

function appendThinking(content) {
  pendingThinking += content;
  if (!currentThinkingEl) {
    const details = document.createElement('details');
    details.className = 'thinking';
    const summary = document.createElement('summary');
    summary.textContent = '思考过程';
    const body = document.createElement('div');
    body.className = 'body';
    details.appendChild(summary);
    details.appendChild(body);
    messagesEl.appendChild(details);
    currentThinkingEl = body;
  }
  currentThinkingEl.textContent = pendingThinking;
  scrollToBottom();
}

function appendToolCard(toolName, isError) {
  const card = document.createElement('div');
  card.className = 'tool-card ' + (isError ? 'error' : 'ok');
  card.innerHTML = `<span class="icon"></span><span>${escapeHtml(toolName)}</span>`;
  messagesEl.appendChild(card);
  scrollToBottom();
}

function appendUserMessage(text) {
  const el = document.createElement('div');
  el.className = 'msg user';
  el.textContent = text;
  messagesEl.appendChild(el);
  scrollToBottom();
}

function appendError(message) {
  const el = document.createElement('div');
  el.className = 'msg assistant';
  el.style.borderLeft = '3px solid var(--vscode-testing-iconFailed, #f85149)';
  el.textContent = '⚠ ' + message;
  messagesEl.appendChild(el);
  scrollToBottom();
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function setRunning(r) {
  running = r;
  sendBtn.disabled = r;
  stopBtn.disabled = !r;
  statusEl.textContent = r ? '运行中...' : '';
}

function resetCurrentStream() {
  currentAssistantEl = null;
  currentThinkingEl = null;
  pendingText = '';
  pendingThinking = '';
}

// ─── 历史回灌 ──────────────────────────────────────────────────────
function renderHistory(messages) {
  messagesEl.innerHTML = '';
  for (const m of messages) {
    if (m.role === 'user') {
      appendUserMessage(m.content);
    } else if (m.role === 'assistant') {
      const el = document.createElement('div');
      el.className = 'msg assistant';
      el.innerHTML = renderMarkdown(m.content);
      messagesEl.appendChild(el);
    } else if (m.role === 'tool') {
      appendToolCard(m.content.slice(0, 60), false);
    }
  }
  scrollToBottom();
}

// ─── 接收扩展消息 ──────────────────────────────────────────────────
window.addEventListener('message', (e) => {
  const msg = e.data;
  switch (msg.type) {
    case 'userMessage':
      appendUserMessage(msg.text);
      break;
    case 'chunk':
      if (msg.chunkType === 'text') appendTextChunk(msg.content);
      else if (msg.chunkType === 'thinking') appendThinking(msg.content);
      break;
    case 'toolStart':
      appendToolCard(msg.toolName, false);
      break;
    case 'toolEnd':
      // 工具卡片在 toolStart 时已渲染；这里仅刷新状态（首版简化：再追加一张结束态卡片）
      // 改进：在 toolStart 时记录 card 引用，toolEnd 时改 class。这里用简化方案。
      appendToolCard(msg.toolName + ' (完成)', !!msg.isError);
      break;
    case 'status':
      setRunning(msg.running);
      break;
    case 'error':
      appendError(msg.message);
      break;
    case 'done':
      resetCurrentStream();
      break;
    case 'historyCleared':
      messagesEl.innerHTML = '';
      resetCurrentStream();
      break;
    case 'history':
      renderHistory(msg.messages);
      break;
  }
});

// ─── 用户输入 ──────────────────────────────────────────────────────
function sendMessage() {
  const text = inputEl.value.trim();
  if (!text || running) return;
  vscode.postMessage({ type: 'send', text });
  inputEl.value = '';
  // 高度复位
  inputEl.style.height = 'auto';
}

sendBtn.addEventListener('click', sendMessage);
stopBtn.addEventListener('click', () => vscode.postMessage({ type: 'stop' }));

inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// textarea 自适应高度
inputEl.addEventListener('input', () => {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + 'px';
});

// 初始状态
setRunning(false);
// 通知扩展：前端已就绪（可用于触发 history 回灌）
vscode.postMessage({ type: 'ready' });
