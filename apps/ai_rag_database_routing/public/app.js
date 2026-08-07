// apps/ai_rag_database_routing/public/app.js
// 前端逻辑:拉取 /api/config、文件/文本上传、POST /api/query(SSE 消费)

const $ = (id) => document.getElementById(id);

const els = {
  status: $('status'),
  model: $('model'),
  apiKey: $('apiKey'),
  apiKeyHint: $('apiKeyHint'),
  apiKeyToggle: $('apiKeyToggle'),
  dbTabs: $('dbTabs'),
  dbPanels: $('dbPanels'),
  question: $('question'),
  askBtn: $('askBtn'),
  copyBtn: $('copyBtn'),
  progress: $('progress'),
  progressTitle: $('progressTitle'),
  routeLine: $('routeLine'),
  answerBox: $('answerBox'),
  answerLabel: $('answerLabel'),
  answer: $('answer'),
  errorBox: $('errorBox'),
  errorText: $('errorText'),
};

// ── 拉取服务状态 ──────────────────────────────────────────────────
let statusInfo = null;
let providerAvailable = new Map();
let providerEnvVar = new Map();
let activeDb = null; // 当前激活的数据库 tab(products/support/finance)
let dbStatsMap = new Map(); // collection -> chunkCount

async function loadStatus() {
  try {
    const res = await fetch('/api/config');
    const cfg = await res.json();
    statusInfo = cfg;
    renderModelSelect(cfg);
    updateStatus();
    updateApiKeyField();
    renderDbTabs(cfg);
  } catch (e) {
    els.status.textContent = '⚠️ 无法连接服务';
  }
}
loadStatus();

// ── 模型选择下拉 + API Key(localStorage 记忆,同 ai_travel_agent)──────
function buildProviderMaps(cfg) {
  providerAvailable = new Map();
  providerEnvVar = new Map();
  for (const m of cfg.models || []) {
    providerAvailable.set(m.provider, m.available);
    providerEnvVar.set(m.provider, m.envVar);
  }
}

function renderModelSelect(cfg) {
  buildProviderMaps(cfg);
  const sel = els.model;
  sel.innerHTML = '';
  const groups = new Map();
  for (const m of cfg.models || []) {
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
  els.status.textContent = `模型 ${currentModelLabel()} · LLM ${llm} · 路由阈值 ${statusInfo.routingThreshold}`;
  els.status.classList.toggle('status--warn', !statusInfo.llmReady);
}

function currentModelChoice() {
  const v = els.model.value || '';
  const idx = v.indexOf(':');
  return idx === -1 ? undefined : { provider: v.slice(0, idx), modelId: v.slice(idx + 1) };
}

function currentModelLabel() {
  const opt = els.model.options[els.model.selectedIndex];
  if (!opt) return statusInfo?.model || '?';
  return opt.textContent.split(' · ')[0];
}

function lsKey(provider) {
  return `rag_db_apikey_${provider}`;
}

function updateApiKeyField() {
  const choice = currentModelChoice();
  if (!choice) return;
  const provider = choice.provider;
  const available = providerAvailable.get(provider);
  const envVar = providerEnvVar.get(provider) || `${provider.toUpperCase()}_API_KEY`;
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
    const saved = localStorage.getItem(lsKey(provider));
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

// ── 数据库 Tab(上传 / 粘贴 / 清空)─────────────────────────────────
function renderDbTabs(cfg) {
  els.dbTabs.innerHTML = '';
  els.dbPanels.innerHTML = '';
  const dbs = cfg.databases || [];
  dbStatsMap = new Map(dbs.map((d) => [d.collection, d]));

  dbs.forEach((db, i) => {
    const tab = document.createElement('button');
    tab.className = `tab${i === 0 ? ' tab--active' : ''}`;
    tab.dataset.collection = db.collection;
    tab.innerHTML = `<span class="tab__name">${escapeHtml(db.name)}</span><span class="tab__count" data-count="${db.collection}">${db.chunkCount}</span>`;
    tab.addEventListener('click', () => switchTab(db.collection));
    els.dbTabs.appendChild(tab);

    const panel = document.createElement('div');
    panel.className = `db-panel${i === 0 ? '' : ' hidden'}`;
    panel.dataset.collection = db.collection;
    panel.innerHTML = `
      <p class="db-panel__desc">${escapeHtml(db.description)}</p>
      <div class="form-row">
        <label class="field field--grow">
          <span>上传文档(<code>.txt</code> / <code>.md</code>,可多选)</span>
          <input type="file" accept=".txt,.md,text/plain,text/markdown" multiple />
        </label>
        <div class="actions">
          <button class="btn btn--primary btn--upload">上传</button>
          <button class="btn btn--ghost btn--clear">清空</button>
        </div>
      </div>
      <label class="field">
        <span>或粘贴文本(每一份粘贴为一个文档)</span>
        <textarea class="paste-text" rows="4" placeholder="粘贴一段文档内容,然后点击「上传」"></textarea>
      </label>
      <div class="upload-status hidden"></div>
    `;
    els.dbPanels.appendChild(panel);
  });

  activeDb = dbs[0]?.collection || null;

  // 绑定面板内按钮事件
  els.dbPanels.querySelectorAll('.db-panel').forEach((panel) => {
    const collection = panel.dataset.collection;
    const fileInput = panel.querySelector('input[type=file]');
    const pasteText = panel.querySelector('.paste-text');
    const uploadBtn = panel.querySelector('.btn--upload');
    const clearBtn = panel.querySelector('.btn--clear');

    uploadBtn.addEventListener('click', async () => {
      const files = [...(fileInput.files || [])];
      const pasted = pasteText.value.trim();
      if (files.length === 0 && !pasted) {
        setUploadStatus(panel, '请选择文件或粘贴文本', 'error');
        return;
      }
      const filePayload = [];
      for (const f of files) {
        try {
          const content = await f.text();
          if (content.trim()) filePayload.push({ name: f.name, content });
        } catch {
          setUploadStatus(panel, `读取文件失败: ${f.name}`, 'error');
        }
      }
      if (filePayload.length === 0 && !pasted) {
        setUploadStatus(panel, '文件内容为空', 'error');
        return;
      }
      uploadBtn.disabled = true;
      try {
        const res = await fetch('/api/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ collection, files: filePayload, texts: pasted }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        setUploadStatus(panel, `已添加 ${data.added} 个片段(跳过重复 ${data.skipped}),当前共 ${data.total} 个片段`, 'ok');
        pasteText.value = '';
        fileInput.value = '';
        refreshDbCounts();
      } catch (e) {
        setUploadStatus(panel, e.message, 'error');
      } finally {
        uploadBtn.disabled = false;
      }
    });

    clearBtn.addEventListener('click', async () => {
      if (!confirm(`确定清空「${dbName(collection)}」数据库吗?此操作不可恢复。`)) return;
      try {
        const res = await fetch('/api/clear', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ collection }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        setUploadStatus(panel, `已清空 ${data.removed} 个片段`, 'ok');
        refreshDbCounts();
      } catch (e) {
        setUploadStatus(panel, e.message, 'error');
      }
    });
  });
}

function switchTab(collection) {
  activeDb = collection;
  els.dbTabs.querySelectorAll('.tab').forEach((t) => {
    t.classList.toggle('tab--active', t.dataset.collection === collection);
  });
  els.dbPanels.querySelectorAll('.db-panel').forEach((p) => {
    p.classList.toggle('hidden', p.dataset.collection !== collection);
  });
}

function dbName(collection) {
  const db = dbStatsMap.get(collection);
  return db ? db.name : collection;
}

function setUploadStatus(panel, msg, kind) {
  const box = panel.querySelector('.upload-status');
  box.classList.remove('hidden');
  box.textContent = msg;
  box.className = `upload-status upload-status--${kind}`;
}

async function refreshDbCounts() {
  try {
    const res = await fetch('/api/config');
    const cfg = await res.json();
    dbStatsMap = new Map((cfg.databases || []).map((d) => [d.collection, d]));
    for (const d of cfg.databases || []) {
      const badge = els.dbTabs.querySelector(`.tab__count[data-count="${d.collection}"]`);
      if (badge) badge.textContent = d.chunkCount;
    }
  } catch {
    // 静默失败
  }
}

// ── 提问(SSE)──────────────────────────────────────────────────────
const ROUTE_META = {
  vector: { label: '向量相似度路由', icon: '🧭' },
  llm: { label: 'LLM 路由', icon: '🤖' },
  none: { label: '网页搜索兜底', icon: '🌐' },
};

els.askBtn.addEventListener('click', async () => {
  const question = els.question.value.trim();
  if (!question) {
    showError('请输入问题');
    return;
  }

  const choice = currentModelChoice();
  const needKey = choice && !providerAvailable.get(choice.provider);
  const apiKey = needKey ? els.apiKey.value.trim() : undefined;
  if (needKey && !apiKey) {
    showError(`请输入 API Key(${providerEnvVar.get(choice.provider) || '需配置'})`);
    return;
  }

  setAsking(true);
  els.answer.textContent = '';
  els.answerBox.classList.add('hidden');
  els.routeLine.classList.add('hidden');
  els.errorBox.classList.add('hidden');
  els.progress.classList.remove('hidden');
  els.progressTitle.textContent = '正在路由…';
  els.copyBtn.disabled = true;

  let answer = '';

  try {
    const res = await fetch('/api/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, model: choice, apiKey }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    // 消费 SSE 流
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

        if (evt.event === 'routing') {
          renderRouting(evt.data);
        } else if (evt.event === 'answer_start') {
          els.progressTitle.textContent = '生成回答中…';
          els.answerLabel.textContent =
            evt.data.source === 'database' ? `回答(来自 ${dbName(evt.data.collection)})` : '回答(来自网页搜索)';
          els.answerBox.classList.remove('hidden');
        } else if (evt.event === 'delta') {
          answer += evt.data.delta;
          els.answer.textContent = answer;
          scrollToBottom();
        } else if (evt.event === 'done') {
          answer = evt.data.answer || answer;
          els.answer.textContent = answer;
        } else if (evt.event === 'error') {
          throw new Error(evt.data.message || '处理失败');
        }
      }
    }

    if (!answer) throw new Error('未收到回答内容');
    els.progressTitle.textContent = '✅ 完成';
    els.copyBtn.disabled = false;
  } catch (e) {
    showError(e.message);
  } finally {
    setAsking(false);
  }
});

function renderRouting(d) {
  els.routeLine.classList.remove('hidden');
  if (d.stage === 'start') {
    els.progressTitle.textContent = '正在路由问题…';
    els.routeLine.textContent = '⏳ 正在路由…';
    els.routeLine.className = 'route-line route-line--active';
    return;
  }
  const meta = ROUTE_META[d.method] || { label: '路由完成', icon: '✔️' };
  let text = `${meta.icon} ${meta.label}`;
  if (d.collection) text += ` → ${dbName(d.collection)}`;
  if (d.confidence != null) text += `(置信度 ${Number(d.confidence).toFixed(3)})`;
  if (d.note) text += ` · ${d.note}`;
  els.routeLine.textContent = text;
  els.routeLine.className = `route-line route-line--${d.method}`;
}

// ── 复制 ──────────────────────────────────────────────────────────
els.copyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(els.answer.textContent || '');
    els.copyBtn.textContent = '已复制 ✓';
    setTimeout(() => (els.copyBtn.textContent = '复制'), 1500);
  } catch {
    showError('复制失败');
  }
});

// ── 辅助 ──────────────────────────────────────────────────────────
function setAsking(on) {
  els.askBtn.disabled = on;
  els.askBtn.textContent = on ? '提问中…' : '提问';
  els.model.disabled = on;
  if (on) {
    els.apiKey.disabled = true;
  } else {
    updateApiKeyField();
  }
}

function showError(msg) {
  els.errorBox.classList.remove('hidden');
  els.errorText.textContent = msg;
}

function scrollToBottom() {
  els.answer.scrollTop = els.answer.scrollHeight;
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

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
