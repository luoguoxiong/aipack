// apps/ai_office_agent/public/app.js
// 前端逻辑:拉取 /api/config → POST /api/chat(SSE 消费流式回答 + 工具阶段)→ 刷新工作区文件面板

const $ = (id) => document.getElementById(id);

const els = {
  model: $('model'),
  modelTrigger: $('modelTrigger'),
  modelTriggerLabel: $('modelTriggerLabel'),
  modelMenu: $('modelMenu'),
  apiKey: $('apiKey'),
  apiKeyHint: $('apiKeyHint'),
  openModelPicker: $('openModelPicker'),
  modelLabel: $('modelLabel'),
  settingsPicker: $('settingsPicker'),
  apiKeySave: $('apiKeySave'),
  messages: $('messages'),
  input: $('input'),
  sendBtn: $('sendBtn'),
  fileSelect: $('fileSelect'),
  fileSelectTrigger: $('fileSelectTrigger'),
  fileSelectLabel: $('fileSelectLabel'),
  fileSelectMenu: $('fileSelectMenu'),
  pickFolder: $('pickFolder'),
  folderInput: $('folderInput'),
  selectedFileBar: $('selectedFileBar'),
  chatToggle: $('chatToggle'),
  previewPane: $('previewPane'),
  previewPaneTitle: $('previewPaneTitle'),
  previewPaneBody: $('previewPaneBody'),
  previewPaneClose: $('previewPaneClose'),
};

let statusInfo = null;
let providerAvailable = new Map();
let providerEnvVar = new Map();
let running = false;
let selectedFile = null; // 选中的目标文件(相对工作区路径)
let modelChoice = null; // 当前模型选择 { provider, modelId }
let modelChoiceLabel = '选择模型'; // 当前模型显示名

// ── 服务状态 ──────────────────────────────────────────────────────
async function loadStatus() {
  try {
    const res = await fetch('/api/config');
    const cfg = await res.json();
    statusInfo = cfg;
    renderModelSelect(cfg);
    updateApiKeyField();
    updateModelLabel();
    refreshFiles();
    // 展示当前工作区文件夹名
    try {
      const wres = await fetch('/api/workspace');
      const wdata = await wres.json();
      updateFolderButton(wdata.root);
    } catch {
      // 忽略:工作区读取失败不阻塞
    }
  } catch {
    // 连接失败:静默处理,文件列表刷新等后续操作自行兜底
  }
}
loadStatus();
// ── 工作区文件夹名展示(选择文件夹按钮上)────────────────────────
function updateFolderButton(root) {
  const name = root ? root.split(/[\\/]/).filter(Boolean).pop() || root : null;
  if (name) {
    els.pickFolder.textContent = `📂 ${name}`;
    els.pickFolder.title = root;
  } else {
    els.pickFolder.textContent = '📂 选择文件夹';
    els.pickFolder.title = '选择本地文件夹作为工作区';
  }
  els.fileSelect.classList.toggle('hidden', !name);
  renderEmptyGuide();
}

// ── 导入文件夹为工作区(上传 → 切换)───────────────────────────────
async function importFiles(items) {
  // items: [{ path, file }]
  if (!items.length) return;
  try {
    // 清空上次导入的内容,再逐文件上传
    await fetch('/api/import-folder', { method: 'DELETE' });
    for (const it of items) {
      const res = await fetch(
        `/api/import-file?path=${encodeURIComponent(it.path)}`,
        {
          method: 'PUT',
          body: it.file,
        },
      );
      if (!res.ok) throw new Error(`上传失败: ${it.path}`);
    }
    const res = await fetch('/api/import-folder/commit', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    if (selectedFile) setSelectedFile(null);
    wsFiles = data.files || [];
    closePreview();
    renderFileSelect(wsFiles);
    updateFolderButton(data.root);
  } catch (err) {
    alert(`导入失败: ${err.message}`);
  }
}

// ── 桌面端(Tauri):原生目录选择器直连工作区,免上传 ─────────────────
async function pickWorkspaceNative() {
  let dirPath;
  try {
    dirPath = await window.__TAURI__.core.invoke('pick_workspace_dir');
  } catch (e) {
    alert(`选择文件夹失败: ${e.message || e}`);
    return;
  }
  if (!dirPath) return; // 用户取消
  try {
    const res = await fetch('/api/workspace', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: dirPath }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    if (selectedFile) setSelectedFile(null);
    wsFiles = data.files || [];
    closePreview();
    renderFileSelect(wsFiles);
    updateFolderButton(data.root);
  } catch (err) {
    alert(`切换失败: ${err.message}`);
  }
}

// 拖拽文件夹导入
function collectEntry(entry, files) {
  return new Promise((resolve) => {
    if (entry.isFile) {
      entry.file(
        (file) => {
          files.push({ path: entry.fullPath.replace(/^\/+/, ''), file });
          resolve();
        },
        () => resolve(),
      );
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const readBatch = () => {
        reader.readEntries(
          (entries) => {
            if (!entries.length) return resolve();
            Promise.all(entries.map((e) => collectEntry(e, files))).then(
              readBatch,
            );
          },
          () => resolve(),
        );
      };
      readBatch();
    } else resolve();
  });
}

async function readDroppedFolder(items) {
  const files = [];
  const pending = [];
  for (const item of items) {
    if (item.kind !== 'file') continue;
    const entry = item.webkitGetAsEntry && item.webkitGetAsEntry();
    if (entry) pending.push(collectEntry(entry, files));
  }
  await Promise.all(pending);
  return files;
}

let dragDepth = 0;
document.addEventListener('dragenter', (e) => {
  if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) {
    dragDepth += 1;
    document.body.classList.add('drag-over');
  }
});
document.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) document.body.classList.remove('drag-over');
});
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('drag-over');
  const items = e.dataTransfer && Array.from(e.dataTransfer.items);
  if (!items || !items.length) return;
  const files = await readDroppedFolder(items);
  if (!files.length) {
    alert('未识别到文件夹,请拖入整个文件夹');
    return;
  }
  await importFiles(files);
});

// ── 选中文件(修改目标 + 预览)────────────────────────────────────
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
  clear.addEventListener('click', () => {
    setSelectedFile(null);
    closePreview();
  });
  chip.appendChild(clear);
  els.selectedFileBar.appendChild(chip);
}

function escapeHtml(s) {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ],
  );
}

function renderModelSelect(cfg) {
  providerAvailable = new Map();
  providerEnvVar = new Map();
  const menu = els.modelMenu;
  menu.innerHTML = '';
  const groups = new Map();
  for (const m of cfg.models || []) {
    providerAvailable.set(m.provider, m.available);
    providerEnvVar.set(m.provider, m.envVar);
    if (!groups.has(m.provider))
      groups.set(m.provider, { name: m.providerName, items: [] });
    groups.get(m.provider).items.push(m);
  }
  for (const [provider, g] of groups) {
    const title = document.createElement('div');
    title.className = 'cselect__group';
    title.textContent = g.name;
    menu.appendChild(title);
    for (const m of g.items) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cselect__item';
      btn.dataset.value = `${provider}:${m.modelId}`;
      btn.innerHTML = `<span class="cselect__item-name">${escapeHtml(m.modelName)}</span>`;
      btn.addEventListener('click', () =>
        pickModel(provider, m.modelId, m.modelName),
      );
      menu.appendChild(btn);
    }
  }
  const dflt = cfg.defaultModel;
  if (dflt) {
    const found = (cfg.models || []).find(
      (m) => m.provider === dflt.provider && m.modelId === dflt.modelId,
    );
    modelChoice = { provider: dflt.provider, modelId: dflt.modelId };
    modelChoiceLabel = found
      ? found.modelName
      : `${dflt.provider}:${dflt.modelId}`;
  } else {
    modelChoice = null;
    modelChoiceLabel = '选择模型';
  }
  updateModelTriggerLabel();
  updateModelLabel();
}

// ── 自定义模型下拉交互 ───────────────────────────────────────────
function pickModel(provider, modelId, modelName) {
  modelChoice = { provider, modelId };
  modelChoiceLabel = modelName;
  closeModelSelect();
  updateModelTriggerLabel();
  updateApiKeyField();
  updateModelLabel();
}

function updateModelTriggerLabel() {
  els.modelTriggerLabel.textContent = modelChoiceLabel;
}

function openModelSelect() {
  els.model.classList.add('open');
  els.modelMenu.classList.remove('hidden');
  syncModelActive();
}

function closeModelSelect() {
  els.model.classList.remove('open');
  els.modelMenu.classList.add('hidden');
}

function syncModelActive() {
  const v = modelChoice ? `${modelChoice.provider}:${modelChoice.modelId}` : '';
  els.modelMenu.querySelectorAll('.cselect__item').forEach((btn) => {
    btn.classList.toggle('cselect__item--active', btn.dataset.value === v);
  });
}

els.modelTrigger.addEventListener('click', () => {
  if (els.modelMenu.classList.contains('hidden')) openModelSelect();
  else closeModelSelect();
});
document.addEventListener('click', (e) => {
  if (!els.model.contains(e.target)) closeModelSelect();
});

function currentModelChoice() {
  return modelChoice || undefined;
}
function currentModelLabel() {
  return modelChoiceLabel || statusInfo?.model || '选择模型';
}

function lsKey(provider) {
  return `office_agent_apikey_${provider}`;
}
function updateApiKeyField() {
  const choice = currentModelChoice();
  if (!choice) return;
  const available = providerAvailable.get(choice.provider);
  const envVar =
    providerEnvVar.get(choice.provider) ||
    `${choice.provider.toUpperCase()}_API_KEY`;
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
function updateModelLabel() {
  els.modelLabel.textContent = currentModelLabel() || '选择模型';
}

// ── 弹窗交互:模型选择 / API Key 设置(同一弹窗) ─────────────────
function openSettings() {
  closeModelSelect();
  updateApiKeyField();
  els.settingsPicker.classList.remove('hidden');
}
els.openModelPicker.addEventListener('click', openSettings);
document.querySelectorAll('[data-close]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const el = document.getElementById(btn.dataset.close);
    if (el) el.classList.add('hidden');
  });
});
document.querySelectorAll('.modal-mask').forEach((mask) => {
  mask.addEventListener('click', (e) => {
    if (e.target === mask) mask.classList.add('hidden');
  });
});
els.apiKeySave.addEventListener('click', () => {
  const choice = currentModelChoice();
  if (choice && !providerAvailable.get(choice.provider)) {
    localStorage.setItem(lsKey(choice.provider), els.apiKey.value.trim());
    els.apiKeyHint.textContent = '✅ 已保存';
    els.apiKeyHint.className = 'hint hint--ok';
  }
  els.settingsPicker.classList.add('hidden');
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
    showErrorMsg(
      `请输入 API Key(${providerEnvVar.get(choice.provider) || '需配置'})`,
    );
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
      body: JSON.stringify({
        message: text,
        model: choice,
        apiKey,
        filePath: selectedFile,
      }),
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
              chip.className =
                'tool-chip ' +
                (d.isError ? 'tool-chip--error' : 'tool-chip--done');
              if (d.isError)
                chip.innerHTML = `<span class="dot"></span>${TOOL_LABELS[d.toolName] || d.toolName} ✗`;
              activeChips.delete(d.toolName);
            }
          }
        } else if (evt.event === 'done') {
          // 完成:刷新文件下拉框;若正在预览文件,自动重新加载预览
          refreshFiles();
          if (previewingPath) openPreview(previewingPath);
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
let wsFiles = []; // 工作区文件列表(供预览中心空态引导展示)
async function refreshFiles() {
  try {
    const res = await fetch('/api/files');
    const data = await res.json();
    wsFiles = data.files || [];
    renderFileSelect(wsFiles);
    renderEmptyGuide();
  } catch {
    // 忽略刷新失败
  }
}

const EXT_ICON = {
  xlsx: '📊',
  xls: '📊',
  csv: '📊',
  docx: '📄',
  doc: '📄',
  txt: '📄',
  md: '📄',
  pptx: '🎞️',
  ppt: '🎞️',
  pdf: '📕',
  png: '🖼️',
  jpg: '🖼️',
  jpeg: '🖼️',
  gif: '🖼️',
  webp: '🖼️',
  svg: '🖼️',
};
function fileIcon(path) {
  const ext = (path.split('.').pop() || '').toLowerCase();
  return EXT_ICON[ext] || '📎';
}
function formatSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/** 文件下拉只展示 Word / Excel / PPT */
const OFFICE_ONLY_EXTS = new Set([
  '.xlsx',
  '.xls',
  '.docx',
  '.doc',
  '.pptx',
  '.ppt',
]);
function officeFilter(files) {
  return (files || []).filter((f) =>
    OFFICE_ONLY_EXTS.has(`.${(f.path.split('.').pop() || '').toLowerCase()}`),
  );
}

function renderFileSelect(files) {
  const office = officeFilter(files);
  els.fileSelectMenu.innerHTML = '';
  closeFileSelect();
  if (!office.length) {
    els.fileSelectTrigger.disabled = true;
    els.fileSelectLabel.textContent = '暂无 Word/Excel/PPT 文件';
    return;
  }
  els.fileSelectTrigger.disabled = false;
  // 占位项(取消选择)
  const ph = document.createElement('button');
  ph.type = 'button';
  ph.className = 'cselect__item cselect__item--placeholder';
  ph.dataset.path = '';
  ph.innerHTML = '<span class="cselect__item-name">— 选择文件 —</span>';
  ph.addEventListener('click', () => pickFile(''));
  els.fileSelectMenu.appendChild(ph);
  for (const f of office) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cselect__item';
    btn.dataset.path = f.path;
    btn.title = f.path;
    btn.innerHTML = `<span class="cselect__item-icon">${fileIcon(f.path)}</span><span class="cselect__item-name">${escapeHtml(f.path)}</span>`;
    btn.addEventListener('click', () => pickFile(f.path));
    els.fileSelectMenu.appendChild(btn);
  }
  updateFileSelectLabel();
  syncFileSelectActive();
}

// ── 自定义文件选择框交互 ─────────────────────────────────────────
function updateFileSelectLabel() {
  els.fileSelectLabel.textContent = selectedFile
    ? `${fileIcon(selectedFile)} ${selectedFile}`
    : '— 选择文件 —';
}

function syncFileSelectActive() {
  els.fileSelectMenu.querySelectorAll('.cselect__item').forEach((btn) => {
    btn.classList.toggle(
      'cselect__item--active',
      btn.dataset.path === (selectedFile || ''),
    );
  });
}

function pickFile(path) {
  closeFileSelect();
  if (path) {
    setSelectedFile(path);
    openPreview(path);
  } else {
    setSelectedFile(null);
    closePreview();
  }
  updateFileSelectLabel();
  syncFileSelectActive();
}

function openFileSelect() {
  if (els.fileSelectTrigger.disabled) return;
  els.fileSelect.classList.add('open');
  els.fileSelectMenu.classList.remove('hidden');
}

function closeFileSelect() {
  els.fileSelect.classList.remove('open');
  els.fileSelectMenu.classList.add('hidden');
}

els.fileSelectTrigger.addEventListener('click', () => {
  if (els.fileSelectMenu.classList.contains('hidden')) openFileSelect();
  else closeFileSelect();
});
document.addEventListener('click', (e) => {
  if (!els.fileSelect.contains(e.target)) closeFileSelect();
});

// ── 文件预览(中央主区域,不弹窗)──────────────────────────────────
let previewingPath = null; // 当前预览的文件(相对工作区路径)
renderEmptyGuide();

function closePreview() {
  previewingPath = null;
  els.previewPaneTitle.textContent = '👁 文件预览';
  renderEmptyGuide();
}

// 预览中心空态引导:未选文件夹→引导选文件夹;已选文件夹→直接展示文件列表
function renderEmptyGuide() {
  if (previewingPath) return; // 正在预览文件时不覆盖
  const hasWorkspace = !els.fileSelect.classList.contains('hidden');
  if (!hasWorkspace) {
    els.previewPaneBody.innerHTML = `
    <div class="preview-empty">
      <div class="preview-empty__icon">📂</div>
      <p class="preview-empty__text">还没有选择文件夹,选择文件夹开始使用</p>
      <div class="preview-empty__actions">
        <button type="button" class="btn btn--primary" id="emptyPickFolder">📂 选择文件夹</button>
      </div>
    </div>`;
    els.previewPaneBody
      .querySelector('#emptyPickFolder')
      ?.addEventListener('click', () => els.pickFolder.click());
    return;
  }
  const office = officeFilter(wsFiles);
  els.previewPaneBody.innerHTML = `
    <div class="preview-empty">
      <div class="preview-empty__icon">📁</div>
      <p class="preview-empty__text">选择文件开始预览</p>
      <div class="preview-files">
        ${office.length
          ? office
              .map(
                (f) =>
                  `<button type="button" class="preview-file" data-path="${escapeHtml(f.path)}">${fileIcon(f.path)}<span>${escapeHtml(f.name || f.path)}</span></button>`,
              )
              .join('')
          : '<p class="preview-files__empty">工作区暂无 Word/Excel/PPT 文件</p>'}
      </div>
    </div>`;
  els.previewPaneBody.querySelectorAll('.preview-file').forEach((b) => {
    b.addEventListener('click', () => {
      const p = b.dataset.path;
      setSelectedFile(p);
      openPreview(p);
      updateFileSelectLabel();
      syncFileSelectActive();
    });
  });
}

async function openPreview(filePath) {
  previewingPath = filePath;
  els.previewPaneTitle.textContent = `👁 加载中: ${filePath}`;
  els.previewPaneBody.innerHTML = '<p class="msg">加载中…</p>';

  let data;
  try {
    const res = await fetch(`/api/preview/${encodeURIComponent(filePath)}`);
    data = await res.json();
  } catch {
    data = { kind: 'error', name: filePath, message: '预览请求失败' };
  }
  if (previewingPath !== filePath) return; // 已切换/关闭,丢弃结果
  renderPreview(data);
}

function renderPreview(data) {
  els.previewPaneTitle.textContent = `👁 ${data.name}`;
  els.previewPaneBody.innerHTML = '';

  const body = els.previewPaneBody;
  if (data.kind === 'office-watch') {
    // officecli watch 渲染的「所见即所得」预览(与 Office 排版一致)
    const iframe = document.createElement('iframe');
    iframe.src = data.url;
    iframe.title = data.name;
    body.appendChild(iframe);
  } else if (data.kind === 'office' || data.kind === 'text') {
    const pre = document.createElement('pre');
    pre.textContent = data.content || '(空文件)';
    body.appendChild(pre);
  } else if (data.kind === 'image') {
    const img = document.createElement('img');
    img.src = data.dataUrl;
    img.alt = data.name;
    body.appendChild(img);
  } else if (data.kind === 'pdf') {
    const iframe = document.createElement('iframe');
    iframe.src = data.url;
    iframe.title = data.name;
    body.appendChild(iframe);
  } else {
    const p = document.createElement('p');
    p.className = 'msg';
    p.textContent = data.message || '暂不支持预览该类型,请下载后查看';
    body.appendChild(p);
  }
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

// 选择工作区:桌面端(Tauri)走原生目录选择器直连,浏览器走系统文件夹选择器上传导入
els.pickFolder.addEventListener('click', () => {
  if (window.__TAURI__) {
    pickWorkspaceNative();
  } else {
    els.folderInput.click();
  }
});
els.folderInput.addEventListener('change', async () => {
  const items = Array.from(els.folderInput.files || []).map((file) => ({
    path: file.webkitRelativePath || file.name,
    file,
  }));
  els.folderInput.value = '';
  if (!items.length) return;
  await importFiles(items);
});
els.chatToggle.addEventListener('click', () => {
  const box = els.chatToggle.closest('.chat-box');
  const collapsed = box.classList.toggle('collapsed');
  els.chatToggle.title = collapsed ? '展开对话框' : '收起对话框';
});
els.previewPaneClose.addEventListener('click', () => {
  setSelectedFile(null);
  closePreview();
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  closeFileSelect();
  closeModelSelect();
  if (selectedFile) {
    setSelectedFile(null);
    closePreview();
  }
});

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
  els.modelTrigger.disabled = on;
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
