// apps/ai_office_agent/public/app.js
// 前端逻辑:拉取 /api/config → POST /api/chat(SSE 消费流式回答 + 工具阶段)→ 刷新工作区文件面板

const $ = (id) => document.getElementById(id);

const els = {
  status: $('status'),
  model: $('model'),
  apiKey: $('apiKey'),
  apiKeyHint: $('apiKeyHint'),
  apiKeyToggle: $('apiKeyToggle'),
  messages: $('messages'),
  input: $('input'),
  sendBtn: $('sendBtn'),
  fileList: $('fileList'),
  refreshFiles: $('refreshFiles'),
  workspaceInput: $('workspaceInput'),
  workspaceApply: $('workspaceApply'),
  workspaceDefault: $('workspaceDefault'),
  workspaceState: $('workspaceState'),
  selectedFileBar: $('selectedFileBar'),
};

let statusInfo = null;
let providerAvailable = new Map();
let providerEnvVar = new Map();
let running = false;
let selectedFile = null; // 选中的目标文件(相对工作区路径)
let defaultWorkspaceRoot = null;

// ── 服务状态 ──────────────────────────────────────────────────────
async function loadStatus() {
  try {
    const res = await fetch('/api/config');
    const cfg = await res.json();
    statusInfo = cfg;
    renderModelSelect(cfg);
    updateStatus();
    updateApiKeyField();
    await loadWorkspace();
    refreshFiles();
  } catch {
    els.status.textContent = '⚠️ 无法连接服务';
  }
}
loadStatus();

// ── 工作区间 ──────────────────────────────────────────────────────
async function loadWorkspace() {
  try {
    const res = await fetch('/api/workspace');
    const data = await res.json();
    defaultWorkspaceRoot = data.defaultRoot;
    els.workspaceInput.value = data.root;
    els.workspaceState.textContent = `当前: ${data.name}`;
    els.workspaceState.className = 'hint hint--ok';
  } catch {
    els.workspaceState.textContent = '读取失败';
    els.workspaceState.className = 'hint';
  }
}

async function applyWorkspace(pathInput) {
  const p = (pathInput || '').trim();
  if (!p) {
    els.workspaceState.textContent = '请输入目录路径';
    els.workspaceState.className = 'hint';
    return;
  }
  try {
    const res = await fetch('/api/workspace', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: p }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    els.workspaceInput.value = data.root;
    els.workspaceState.textContent = `当前: ${data.name} ✓`;
    els.workspaceState.className = 'hint hint--ok';
    // 切换工作区后:清空可能失效的选中文件,刷新面板
    if (selectedFile) setSelectedFile(null);
    renderFileList(data.files || []);
    updateStatus();
  } catch (e) {
    els.workspaceState.textContent = `切换失败: ${e.message}`;
    els.workspaceState.className = 'hint';
  }
}

els.workspaceApply.addEventListener('click', () => applyWorkspace(els.workspaceInput.value));
els.workspaceInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') applyWorkspace(els.workspaceInput.value);
});
els.workspaceDefault.addEventListener('click', () => {
  if (defaultWorkspaceRoot) applyWorkspace(defaultWorkspaceRoot);
});

// ── 选中文件(修改目标)─────────────────────────────────────────────
function setSelectedFile(filePath) {
  selectedFile = filePath || null;
  els.selectedFileBar.classList.toggle('hidden', !selectedFile);
  els.selectedFileBar.innerHTML = '';
  if (!selectedFile) return;
  const chip = document.createElement('span');
  chip.className = 'selected-chip';
  chip.innerHTML = `🎯 修改目标: <code>${escapeHtml(selectedFile)}</code>`;
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'selected-chip__x';
  clear.textContent = '✕';
  clear.title = '取消选中';
  clear.addEventListener('click', () => setSelectedFile(null));
  chip.appendChild(clear);
  els.selectedFileBar.appendChild(chip);
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderModelSelect(cfg) {
  providerAvailable = new Map();
  providerEnvVar = new Map();
  const sel = els.model;
  sel.innerHTML = '';
  const groups = new Map();
  for (const m of cfg.models || []) {
    providerAvailable.set(m.provider, m.available);
    providerEnvVar.set(m.provider, m.envVar);
    if (!groups.has(m.provider)) groups.set(m.provider, { name: m.providerName, items: [] });
    groups.get(m.provider).items.push(m);
  }
  for (const [provider, g] of groups) {
    const og = document.createElement('optgroup');
    og.label = g.name;
    for (const m of g.items) {
      const opt = document.createElement('option');
      opt.value = `${provider}:${m.modelId}`;
      opt.textContent = m.modelName;
      og.appendChild(opt);
    }
    sel.appendChild(og);
  }
  const dflt = cfg.defaultModel;
  if (dflt) sel.value = `${dflt.provider}:${dflt.modelId}`;
}

function updateStatus() {
  if (!statusInfo) return;
  const llm = statusInfo.llmReady ? '✅ 已就绪' : '❌ 未配置(请设置 API Key)';
  els.status.textContent = `模型 ${currentModelLabel()} · LLM ${llm} · 工作区 ${statusInfo.workspace} · 工具 ${(statusInfo.tools || []).length} 个`;
  els.status.classList.toggle('status--warn', !statusInfo.llmReady);
}

function currentModelChoice() {
  const v = els.model.value || '';
  const idx = v.indexOf(':');
  return idx === -1 ? undefined : { provider: v.slice(0, idx), modelId: v.slice(idx + 1) };
}
function currentModelLabel() {
  const opt = els.model.options[els.model.selectedIndex];
  return opt ? opt.textContent.split(' · ')[0] : statusInfo?.model || '?';
}

function lsKey(provider) {
  return `office_agent_apikey_${provider}`;
}
function updateApiKeyField() {
  const choice = currentModelChoice();
  if (!choice) return;
  const available = providerAvailable.get(choice.provider);
  const envVar = providerEnvVar.get(choice.provider) || `${choice.provider.toUpperCase()}_API_KEY`;
  if (available) {
    els.apiKey.disabled = true;
    els.apiKey.value = '';
    els.apiKey.placeholder = '已用服务器配置,无需输入';
    els.apiKeyHint.textContent = '✅ 已用服务器配置';
    els.apiKeyHint.className = 'hint hint--ok';
  } else {
    els.apiKey.disabled = false;
    els.apiKey.placeholder = `输入 ${envVar}`;
    els.apiKeyHint.textContent = `需要 ${envVar}`;
    els.apiKeyHint.className = 'hint';
    const saved = localStorage.getItem(lsKey(choice.provider));
    if (saved) els.apiKey.value = saved;
  }
}
els.model.addEventListener('change', () => {
  updateStatus();
  updateApiKeyField();
});
els.apiKey.addEventListener('input', () => {
  const choice = currentModelChoice();
  if (choice) localStorage.setItem(lsKey(choice.provider), els.apiKey.value);
});
els.apiKeyToggle.addEventListener('click', () => {
  els.apiKey.type = els.apiKey.type === 'password' ? 'text' : 'password';
});

// ── 消息渲染 ──────────────────────────────────────────────────────
const TOOL_LABELS = {
  office_read: '📖 文档读取',
  office_help: '📚 语法查询',
  office_exec: '⚙️ 文档操作',
  file_list: '📁 文件列表',
  file_delete: '🗑️ 删除文件',
};

function addUserMsg(text) {
  const div = document.createElement('div');
  div.className = 'msg msg--user';
  div.innerHTML = `<div class="msg__bubble"></div>`;
  div.querySelector('.msg__bubble').textContent = text;
  els.messages.appendChild(div);
  scrollBottom();
}

function addAssistantBubble() {
  const div = document.createElement('div');
  div.className = 'msg msg--assistant';
  div.innerHTML = `<div class="msg__bubble"></div>`;
  els.messages.appendChild(div);
  scrollBottom();
  return div.querySelector('.msg__bubble');
}

function addToolbar() {
  const bar = document.createElement('div');
  bar.className = 'toolbar';
  els.messages.appendChild(bar);
  scrollBottom();
  return bar;
}

function addToolChip(bar, name) {
  const chip = document.createElement('span');
  chip.className = 'tool-chip tool-chip--active';
  chip.dataset.name = name;
  chip.innerHTML = `<span class="dot"></span>${TOOL_LABELS[name] || `🔧 ${name}`}`;
  bar.appendChild(chip);
  scrollBottom();
  return chip;
}

function showErrorMsg(msg) {
  const div = document.createElement('div');
  div.className = 'msg msg--error';
  div.innerHTML = `<div class="msg__bubble">⚠️ ${msg}</div>`;
  els.messages.appendChild(div);
  scrollBottom();
}

function scrollBottom() {
  els.messages.scrollTop = els.messages.scrollHeight;
}

// ── 发送消息(SSE)─────────────────────────────────────────────────
async function sendMessage(text) {
  const choice = currentModelChoice();
  const needKey = choice && !providerAvailable.get(choice.provider);
  const apiKey = needKey ? els.apiKey.value.trim() : undefined;
  if (needKey && !apiKey) {
    showErrorMsg(`请输入 API Key(${providerEnvVar.get(choice.provider) || '需配置'})`);
    return;
  }

  setRunning(true);
  addUserMsg(text);
  const bubble = addAssistantBubble();
  let toolbar = null;
  const activeChips = new Map();
  let full = '';

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, model: choice, apiKey, filePath: selectedFile }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sep;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const evt = parseSse(raw);
        if (!evt) continue;

        if (evt.event === 'delta') {
          full += evt.data.delta || '';
          bubble.textContent = full;
          scrollBottom();
        } else if (evt.event === 'thinking') {
          // 思考过程不展示,只记入进度(可选)
        } else if (evt.event === 'tool') {
          const d = evt.data;
          if (!toolbar) toolbar = addToolbar();
          if (d.state === 'start') {
            const chip = addToolChip(toolbar, d.toolName);
            activeChips.set(d.toolName, chip);
          } else if (d.state === 'end') {
            const chip = activeChips.get(d.toolName);
            if (chip) {
              chip.className = 'tool-chip ' + (d.isError ? 'tool-chip--error' : 'tool-chip--done');
              if (d.isError) chip.innerHTML = `<span class="dot"></span>${TOOL_LABELS[d.toolName] || d.toolName} ✗`;
              activeChips.delete(d.toolName);
            }
          }
        } else if (evt.event === 'done') {
          // 完成:刷新文件面板
          refreshFiles();
        } else if (evt.event === 'error') {
          throw new Error(evt.data.message || '处理失败');
        }
      }
    }
    if (!full) throw new Error('未收到回复内容');
  } catch (e) {
    showErrorMsg(e.message);
  } finally {
    setRunning(false);
    els.input.focus();
  }
}

// ── 文件面板 ──────────────────────────────────────────────────────
async function refreshFiles() {
  try {
    const res = await fetch('/api/files');
    const data = await res.json();
    renderFileList(data.files || []);
  } catch {
    // 忽略刷新失败
  }
}

function renderFileList(files) {
  els.fileList.innerHTML = '';
  if (!files || !files.length) {
    const li = document.createElement('li');
    li.className = 'file-list__empty';
    li.textContent = '暂无文件(让助手创建/修改 Office 文档试试)';
    els.fileList.appendChild(li);
    return;
  }
  for (const f of files) {
    const li = document.createElement('li');
    li.className = 'file-item';
    li.dataset.path = f.path;

    const a = document.createElement('a');
    a.href = `/api/files/${encodeURIComponent(f.path)}`;
    a.download = '';
    a.textContent = f.path;
    a.title = `下载 ${f.path}`;
    a.className = 'file-item__name';

    const size = document.createElement('span');
    size.className = 'size';
    size.textContent = formatSize(f.size);

    const btnSelect = document.createElement('button');
    btnSelect.type = 'button';
    btnSelect.className = 'btn btn--ghost btn--xs';
    btnSelect.textContent = selectedFile === f.path ? '✓ 已选中' : '选中修改';
    btnSelect.title = selectedFile === f.path ? '取消选中' : '选中该文件作为修改目标';
    btnSelect.classList.toggle('is-selected', selectedFile === f.path);
    btnSelect.addEventListener('click', () => {
      if (selectedFile === f.path) {
        setSelectedFile(null);
      } else {
        setSelectedFile(f.path);
      }
      // 重绘所有行的选中态
      document.querySelectorAll('.file-item').forEach((item) => {
        const b = item.querySelector('.file-item button');
        const isSel = item.dataset.path === selectedFile;
        if (b) {
          b.classList.toggle('is-selected', isSel);
          b.textContent = isSel ? '✓ 已选中' : '选中修改';
          b.title = isSel ? '取消选中' : '选中该文件作为修改目标';
        }
      });
    });

    li.append(a, size, btnSelect);
    els.fileList.appendChild(li);
  }
}

function formatSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

// ── 事件绑定 ──────────────────────────────────────────────────────
els.sendBtn.addEventListener('click', () => {
  const text = els.input.value.trim();
  if (!text || running) return;
  els.input.value = '';
  sendMessage(text);
});

els.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    els.sendBtn.click();
  }
});

els.refreshFiles.addEventListener('click', refreshFiles);

document.querySelectorAll('.chip').forEach((btn) => {
  btn.addEventListener('click', () => {
    els.input.value = btn.dataset.prompt;
    els.input.focus();
    if (running) return;
    els.input.value = '';
    sendMessage(btn.dataset.prompt);
  });
});

function setRunning(on) {
  running = on;
  els.sendBtn.disabled = on;
  els.sendBtn.textContent = on ? '处理中…' : '发送';
  els.model.disabled = on;
  if (on) {
    els.apiKey.disabled = true;
  } else {
    updateApiKeyField();
  }
}

function parseSse(raw) {
  let event = 'message';
  const dataLines = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return null;
  try {
    return { event, data: JSON.parse(dataLines.join('\n')) };
  } catch {
    return { event, data: { raw: dataLines.join('\n') } };
  }
}
