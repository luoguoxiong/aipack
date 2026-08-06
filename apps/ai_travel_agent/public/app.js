// apps/ai_travel_agent/public/app.js
// 前端逻辑:拉取 /api/config、POST /api/plan(SSE 消费)、下载 /api/ics

const $ = (id) => document.getElementById(id);

const els = {
  status: $('status'),
  destination: $('destination'),
  days: $('days'),
  startDate: $('startDate'),
  generateBtn: $('generateBtn'),
  downloadBtn: $('downloadBtn'),
  copyBtn: $('copyBtn'),
  progress: $('progress'),
  progressTitle: $('progressTitle'),
  stageList: $('stageList'),
  result: $('result'),
  itinerary: $('itinerary'),
  errorBox: $('errorBox'),
  errorText: $('errorText'),
};

// 默认出发日期 = 今天
els.startDate.valueAsDate = new Date();

// ── 拉取服务状态 ──────────────────────────────────────────────────
async function loadStatus() {
  try {
    const res = await fetch('/api/config');
    const cfg = await res.json();
    const llm = cfg.llmReady ? '✅ 已就绪' : '❌ 未配置(请设置 API Key)';
    els.status.textContent = `模型 ${cfg.model} · LLM ${llm} · 搜索:${cfg.searchBackend}`;
    els.status.classList.toggle('status--warn', !cfg.llmReady);
  } catch (e) {
    els.status.textContent = '⚠️ 无法连接服务';
  }
}
loadStatus();

// ── 阶段渲染 ──────────────────────────────────────────────────────
const STAGES = {
  research_start: { label: '🔎 研究目的地', state: 'active' },
  research_done: { label: '🔎 研究目的地', state: 'done' },
  plan_start: { label: '🗺️ 生成行程', state: 'active' },
};

function renderStages(activeStage, research) {
  els.stageList.innerHTML = '';
  const order = ['research_start', 'research_done', 'plan_start'];
  const reached = order.indexOf(activeStage);
  for (const key of ['research_start', 'plan_start']) {
    const meta = STAGES[key];
    const idx = order.indexOf(key);
    const div = document.createElement('div');
    div.className = `stage stage--${idx <= reached ? (idx === reached && activeStage.endsWith('start') ? 'active' : 'done') : 'pending'}`;
    div.textContent = meta.label;
    els.stageList.appendChild(div);
  }
  if (research) {
    const det = document.createElement('details');
    det.className = 'research-details';
    det.innerHTML = `<summary>查看研究结果</summary><pre>${escapeHtml(research)}</pre>`;
    els.stageList.appendChild(det);
  }
}

// ── 生成行程(SSE)──────────────────────────────────────────────────
els.generateBtn.addEventListener('click', async () => {
  const destination = els.destination.value.trim();
  const days = Number(els.days.value) || 7;
  if (!destination) {
    showError('请输入目的地');
    return;
  }

  setGenerating(true);
  els.itinerary.textContent = '';
  els.result.classList.add('hidden');
  els.errorBox.classList.add('hidden');
  els.progress.classList.remove('hidden');
  els.progressTitle.textContent = '准备中…';
  renderStages('research_start');
  els.downloadBtn.disabled = true;

  let itinerary = '';

  try {
    const res = await fetch('/api/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ destination, days }),
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
          els.progressTitle.textContent = d.stage === 'research_start' ? '正在研究目的地…' : d.stage === 'plan_start' ? '正在生成行程…' : '研究完成';
          renderStages(d.stage, d.research);
        } else if (evt.event === 'delta') {
          itinerary += evt.data.delta;
          els.result.classList.remove('hidden');
          els.itinerary.textContent = itinerary;
          scrollToBottom();
        } else if (evt.event === 'done') {
          itinerary = evt.data.itinerary || itinerary;
          els.itinerary.textContent = itinerary;
        } else if (evt.event === 'error') {
          throw new Error(evt.data.message || '生成失败');
        }
      }
    }

    if (!itinerary) throw new Error('未收到行程内容');
    els.progressTitle.textContent = '✅ 完成';
    renderStages('plan_start');
    els.downloadBtn.disabled = false;
    els.copyBtn.disabled = false;
  } catch (e) {
    showError(e.message);
  } finally {
    setGenerating(false);
  }
});

// ── 下载 ICS ──────────────────────────────────────────────────────
els.downloadBtn.addEventListener('click', async () => {
  const itinerary = els.itinerary.textContent;
  if (!itinerary) return;
  const startDate = els.startDate.value || undefined;
  const res = await fetch('/api/ics', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ itinerary, startDate }),
  });
  if (!res.ok) {
    showError('生成 ICS 失败');
    return;
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'travel_itinerary.ics';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});

// ── 复制 ──────────────────────────────────────────────────────────
els.copyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(els.itinerary.textContent || '');
    els.copyBtn.textContent = '已复制 ✓';
    setTimeout(() => (els.copyBtn.textContent = '复制'), 1500);
  } catch {
    showError('复制失败');
  }
});

// ── 辅助 ──────────────────────────────────────────────────────────
function setGenerating(on) {
  els.generateBtn.disabled = on;
  els.generateBtn.textContent = on ? '生成中…' : '生成行程';
}

function showError(msg) {
  els.errorBox.classList.remove('hidden');
  els.errorText.textContent = msg;
}

function scrollToBottom() {
  els.itinerary.scrollTop = els.itinerary.scrollHeight;
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
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
