// apps/ai_blog_to_podcast_agent/public/app.js
// 前端逻辑:拉取 /api/config、POST /api/podcast(SSE 消费摘要)、POST /api/tts(获取 mp3 Blob)

const $ = (id) => document.getElementById(id);

const els = {
  status: $('status'),
  model: $('model'),
  url: $('url'),
  apiKey: $('apiKey'),
  apiKeyHint: $('apiKeyHint'),
  apiKeyToggle: $('apiKeyToggle'),
  voice: $('voice'),
  rate: $('rate'),
  generateBtn: $('generateBtn'),
  downloadBtn: $('downloadBtn'),
  copyBtn: $('copyBtn'),
  progress: $('progress'),
  progressTitle: $('progressTitle'),
  stageList: $('stageList'),
  result: $('result'),
  summary: $('summary'),
  audioBox: $('audioBox'),
  audioPlayer: $('audioPlayer'),
  audioMeta: $('audioMeta'),
  errorBox: $('errorBox'),
  errorText: $('errorText'),
};

// 语音与语速持久化(localStorage)
const savedVoice = localStorage.getItem('blog_podcast_voice') || '';
const savedRate = localStorage.getItem('blog_podcast_rate') || '+0%';
if (savedRate) els.rate.value = savedRate;
els.rate.addEventListener('change', () => {
  localStorage.setItem('blog_podcast_rate', els.rate.value);
});

// ── 拉取服务状态 ──────────────────────────────────────────────────
let statusInfo = null;
let providerAvailable = new Map();
let providerEnvVar = new Map();
let currentAudioUrl = null;

async function loadStatus() {
  try {
    const res = await fetch('/api/config');
    const cfg = await res.json();
    statusInfo = cfg;
    renderModelSelect(cfg);
    renderVoiceSelect(cfg);
    updateStatus();
    updateApiKeyField();
  } catch (e) {
    els.status.textContent = '⚠️ 无法连接服务';
  }
}
loadStatus();

// ── 语音选择下拉(按语言分组)─────────────────────────────────────
function renderVoiceSelect(cfg) {
  const sel = els.voice;
  sel.innerHTML = '';
  const groups = new Map();
  for (const v of cfg.voices || []) {
    if (!groups.has(v.lang)) groups.set(v.lang, []);
    groups.get(v.lang).push(v);
  }
  for (const [lang, items] of groups) {
    const og = document.createElement('optgroup');
    og.label = lang;
    for (const v of items) {
      const opt = document.createElement('option');
      opt.value = v.id;
      opt.textContent = v.name;
      og.appendChild(opt);
    }
    sel.appendChild(og);
  }
  // 回填上次选择,否则默认第一个中文语音
  if (savedVoice && [...sel.options].some((o) => o.value === savedVoice)) {
    sel.value = savedVoice;
  } else {
    sel.value = 'zh-CN-XiaoxiaoNeural';
  }
}

els.voice.addEventListener('change', () => {
  localStorage.setItem('blog_podcast_voice', els.voice.value);
});

// ── 模型选择下拉(按 provider 分组;未配置 Key 的可在下方输入)────────
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
  els.status.textContent = `模型 ${currentModelLabel()} · LLM ${llm} · 抓取:${statusInfo.scrapeBackend} · TTS:${statusInfo.ttsBackend || 'edge-tts'}`;
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

// ── API Key 字段联动(已配 provider 禁用,未配启用 + localStorage 记忆)──
function lsKey(provider) {
  return `blog_podcast_apikey_${provider}`;
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

// ── 阶段渲染 ──────────────────────────────────────────────────────
const STAGES = {
  scrape_start: { label: '📰 抓取博客正文' },
  summary_start: { label: '✍️ 生成播客摘要' },
};

function renderStages(activeStage) {
  els.stageList.innerHTML = '';
  // 两个阶段:抓取 → 摘要
  const order = ['scrape_start', 'summary_start'];
  const activeIdx = order.indexOf(activeStage);
  for (let i = 0; i < order.length; i++) {
    const key = order[i];
    const meta = STAGES[key];
    const div = document.createElement('div');
    let state;
    if (activeIdx === -1) state = 'pending';
    else if (i < activeIdx) state = 'done';
    else if (i === activeIdx) state = 'active';
    else state = 'pending';
    // scrape_done 时把抓取阶段标 done
    if (activeStage === 'scrape_done' && key === 'scrape_start') state = 'done';
    div.className = `stage stage--${state}`;
    div.textContent = meta.label;
    els.stageList.appendChild(div);
  }
}

// ── 生成播客(SSE 摘要 + TTS)───────────────────────────────────────
els.generateBtn.addEventListener('click', async () => {
  const url = els.url.value.trim();
  if (!url) {
    showError('请输入博客 URL');
    return;
  }

  // 未在服务器配 Key 的 provider,要求用户输入 LLM API Key
  const choice = currentModelChoice();
  const needKey = choice && !providerAvailable.get(choice.provider);
  const apiKey = needKey ? els.apiKey.value.trim() : undefined;
  if (needKey && !apiKey) {
    showError(`请输入 API Key(${providerEnvVar.get(choice.provider) || '需配置'})`);
    return;
  }

  setGenerating(true);
  els.summary.textContent = '';
  els.result.classList.add('hidden');
  els.audioBox.classList.add('hidden');
  els.errorBox.classList.add('hidden');
  els.progress.classList.remove('hidden');
  els.progressTitle.textContent = '准备中…';
  renderStages('scrape_start');
  els.downloadBtn.disabled = true;
  els.copyBtn.disabled = true;
  // 清理上一轮音频 URL
  if (currentAudioUrl) {
    URL.revokeObjectURL(currentAudioUrl);
    currentAudioUrl = null;
  }
  els.audioPlayer.src = '';

  let summary = '';

  try {
    const res = await fetch('/api/podcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, model: choice, apiKey }),
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

      // SSE 以 \n\n 分隔事件
      let sep;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const evt = parseSse(raw);
        if (!evt) continue;

        if (evt.event === 'stage') {
          const d = evt.data;
          els.progressTitle.textContent =
            d.stage === 'scrape_start'
              ? '正在抓取博客正文…'
              : d.stage === 'scrape_done'
                ? '抓取完成,准备生成摘要…'
                : d.stage === 'summary_start'
                  ? '正在生成播客摘要…'
                  : '处理中';
          renderStages(d.stage);
        } else if (evt.event === 'delta') {
          summary += evt.data.delta;
          els.result.classList.remove('hidden');
          els.summary.textContent = summary;
          scrollToBottom();
        } else if (evt.event === 'done') {
          summary = evt.data.summary || summary;
          els.summary.textContent = summary;
        } else if (evt.event === 'error') {
          throw new Error(evt.data.message || '生成失败');
        }
      }
    }

    if (!summary) throw new Error('未收到摘要内容');
    els.progressTitle.textContent = '✅ 摘要完成,正在合成语音…';
    els.copyBtn.disabled = false;

    // ── 摘要完成后调用 /api/tts 获取音频(Edge TTS 免费,无需 Key)────────
    const voice = els.voice.value || undefined;
    const rate = els.rate.value || undefined;
    const ttsRes = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: summary, voice, rate }),
    });
    if (!ttsRes.ok) {
      const err = await ttsRes.json().catch(() => ({}));
      throw new Error(err.error || err.message || `TTS HTTP ${ttsRes.status}`);
    }
    const blob = await ttsRes.blob();
    currentAudioUrl = URL.createObjectURL(blob);
    els.audioPlayer.src = currentAudioUrl;
    const voiceUsed = ttsRes.headers.get('X-TTS-Voice') || voice || '?';
    const sizeMb = (blob.size / 1024 / 1024).toFixed(2);
    els.audioMeta.textContent = `语音:${voiceUsed} · 大小:${sizeMb} MB`;
    els.audioBox.classList.remove('hidden');
    els.progressTitle.textContent = '✅ 完成';
    renderStages('summary_start'); // 标记摘要阶段为 active(随后由完成态展示)
    // 标记全部完成
    [...els.stageList.children].forEach((c) => (c.className = 'stage stage--done'));
    els.downloadBtn.disabled = false;
  } catch (e) {
    showError(e.message);
  } finally {
    setGenerating(false);
  }
});

// ── 下载播客(复用 currentAudioUrl,避免二次请求)──────────────────
els.downloadBtn.addEventListener('click', () => {
  if (!currentAudioUrl) return;
  const a = document.createElement('a');
  a.href = currentAudioUrl;
  a.download = 'podcast.mp3';
  document.body.appendChild(a);
  a.click();
  a.remove();
});

// ── 复制摘要 ──────────────────────────────────────────────────────
els.copyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(els.summary.textContent || '');
    els.copyBtn.textContent = '已复制 ✓';
    setTimeout(() => (els.copyBtn.textContent = '复制'), 1500);
  } catch {
    showError('复制失败');
  }
});

// ── 辅助 ──────────────────────────────────────────────────────────
function setGenerating(on) {
  els.generateBtn.disabled = on;
  els.generateBtn.textContent = on ? '生成中…' : '生成播客';
  // 生成执行期间禁止切换模型 / 改 API Key / 改语音,避免与进行中的请求不一致
  els.model.disabled = on;
  els.voice.disabled = on;
  els.rate.disabled = on;
  if (on) {
    els.apiKey.disabled = true;
  } else {
    // 结束后按当前 provider 恢复 API Key 字段状态(已配→禁用,未配→启用并回填)
    updateApiKeyField();
  }
}

function showError(msg) {
  els.errorBox.classList.remove('hidden');
  els.errorText.textContent = msg;
}

function scrollToBottom() {
  els.summary.scrollTop = els.summary.scrollHeight;
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
