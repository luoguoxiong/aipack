// apps/ai_teaching_agent_team/frontend/src/App.tsx
// 主状态机:加载配置 → 模型/Key 联动 → 生成(SSE 4 阶段流式) → 4 分区渲染 → 下载 Markdown。
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchConfig,
  streamTeach,
  apiKeyStorageKey,
  type AgentRole,
  type ServerConfig,
} from './api';
import { AGENTS } from './agents';
import { ConfigBar } from './components/ConfigBar';
import { StageProgress, type StageStatus } from './components/StageProgress';
import { SectionPanel } from './components/SectionPanel';

const EMPTY_SECTIONS: Record<AgentRole, string> = { professor: '', advisor: '', librarian: '', ta: '' };
const PENDING_STATUS: Record<AgentRole, StageStatus> = { professor: 'pending', advisor: 'pending', librarian: 'pending', ta: 'pending' };

function agentFromStage(stage: string): AgentRole {
  return stage.replace(/_(start|done)$/, '') as AgentRole;
}

export default function App() {
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [modelValue, setModelValue] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [topic, setTopic] = useState('Transformer 原理');

  const [generating, setGenerating] = useState(false);
  const [sections, setSections] = useState<Record<AgentRole, string>>(EMPTY_SECTIONS);
  const [stageStatus, setStageStatus] = useState<Record<AgentRole, StageStatus>>(PENDING_STATUS);
  const [course, setCourse] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  // ── 加载服务配置 ──────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    fetchConfig()
      .then((cfg) => {
        if (cancelled) return;
        setConfig(cfg);
        const dflt = cfg.defaultModel;
        const mv = `${dflt.provider}:${dflt.modelId}`;
        setModelValue(mv);
        // 回填该 provider 的 localStorage API Key
        const saved = localStorage.getItem(apiKeyStorageKey(dflt.provider));
        if (saved) setApiKey(saved);
      })
      .catch(() => {
        if (!cancelled) setError('无法连接服务,请确认后端已启动(pnpm --filter ai-teaching-agent-team dev)');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // ── 模型/Key 联动 ─────────────────────────────────────────────
  const handleModelChange = useCallback(
    (value: string) => {
      setModelValue(value);
      const provider = value.slice(0, value.indexOf(':'));
      const saved = localStorage.getItem(apiKeyStorageKey(provider));
      setApiKey(saved || '');
    },
    [],
  );

  const handleApiKeyChange = useCallback((value: string) => {
    setApiKey(value);
    const provider = modelValue.slice(0, modelValue.indexOf(':'));
    localStorage.setItem(apiKeyStorageKey(provider), value);
  }, [modelValue]);

  // ── 当前 provider 是否已用服务器配置 Key ──────────────────────
  const currentProvider = modelValue.slice(0, modelValue.indexOf(':')) || config?.provider || 'deepseek';
  const providerAvailableOnServer =
    config?.models.find((m) => m.provider === currentProvider)?.available ?? false;
  const needKey = !providerAvailableOnServer;

  // ── 生成 ──────────────────────────────────────────────────────
  const generate = useCallback(async () => {
    const t = topic.trim();
    if (!t) {
      setError('请输入学习主题');
      return;
    }
    if (needKey && !apiKey.trim()) {
      setError(`请输入 API Key(${currentProvider.toUpperCase()}_API_KEY)`);
      return;
    }
    if (!config) return;

    const modelChoice = modelValue
      ? { provider: currentProvider, modelId: modelValue.slice(modelValue.indexOf(':') + 1) }
      : undefined;

    // 重置
    setError(null);
    setCourse(null);
    setSections(EMPTY_SECTIONS);
    setStageStatus(PENDING_STATUS);
    setGenerating(true);

    const ac = new AbortController();
    abortRef.current = ac;

    try {
      await streamTeach(
        { topic: t, model: modelChoice, apiKey: needKey ? apiKey.trim() : undefined },
        {
          signal: ac.signal,
          onStage(stage, section) {
            const agent = agentFromStage(stage);
            if (stage.endsWith('_start')) {
              setStageStatus((s) => ({ ...s, [agent]: 'active' }));
            } else if (stage.endsWith('_done')) {
              setStageStatus((s) => ({ ...s, [agent]: 'done' }));
              if (section) setSections((s) => ({ ...s, [agent]: section }));
            }
          },
          onDelta(agent, delta) {
            setSections((s) => ({ ...s, [agent]: (s[agent] || '') + delta }));
          },
          onDone(c) {
            setCourse(c);
            setStageStatus({ professor: 'done', advisor: 'done', librarian: 'done', ta: 'done' });
          },
          onError(msg) {
            setError(msg);
          },
        },
      );
    } catch (e) {
      const err = e as Error;
      if (err.name === 'AbortError') {
        // 用户取消,静默
      } else {
        setError(err.message || '生成失败');
      }
    } finally {
      setGenerating(false);
      abortRef.current = null;
    }
  }, [topic, needKey, apiKey, config, modelValue, currentProvider]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    setGenerating(false);
  }, []);

  const download = useCallback(() => {
    if (!course) return;
    const blob = new Blob([course], { type: 'text/markdown; charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `course_${topic.trim() || 'teaching'}.md`.replace(/\s+/g, '_');
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, [course, topic]);

  const copyCourse = useCallback(async () => {
    if (!course) return;
    try {
      await navigator.clipboard.writeText(course);
    } catch {
      setError('复制失败');
    }
  }, [course]);

  return (
    <>
      <header className="hero">
        <div className="hero__overlay">
          <h1>👨‍🏫 AI Teaching Agent Team</h1>
          <p className="hero__sub">
            基于 aipack 的 4-Agent 教学团队 · Professor 构建知识库 → Advisor 设计路线 → Librarian 策展资源 → TA 出练习 · 可导出 Markdown
          </p>
          {!config ? (
            <div className="status">读取服务状态…</div>
          ) : null}
        </div>
      </header>

      <main className="container">
        {config && (
          <ConfigBar
            config={config}
            modelValue={modelValue}
            onModelChange={handleModelChange}
            apiKey={apiKey}
            onApiKeyChange={handleApiKeyChange}
            disabled={generating}
          />
        )}

        <section className="card form-card">
          <h2>规划你的课程</h2>
          <div className="form-row">
            <label className="field field--grow">
              <span>学习主题</span>
              <input
                type="text"
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder="例如:Python 入门、机器学习、区块链原理、快速排序"
                disabled={generating}
              />
            </label>
            <div className="actions">
              {generating ? (
                <button className="btn btn--ghost" onClick={cancel}>
                  取消
                </button>
              ) : null}
              <button className="btn btn--primary" onClick={generate} disabled={generating}>
                {generating ? '生成中…' : '开始生成课程'}
              </button>
            </div>
          </div>
        </section>

        {(generating || course || Object.values(sections).some(Boolean)) && (
          <section className="card progress-card">
            <h2>团队进度</h2>
            <StageProgress status={stageStatus} />
          </section>
        )}

        {AGENTS.map((a) => (
          <SectionPanel
            key={a.role}
            agent={a.role}
            emoji={a.emoji}
            title={`${a.emoji} ${a.title} · ${a.label}`}
            status={stageStatus[a.role]}
            content={sections[a.role]}
          />
        ))}

        {course && (
          <section className="card result-card">
            <div className="result-head">
              <h2>课程已生成</h2>
              <div className="actions">
                <button className="btn btn--ghost btn--sm" onClick={copyCourse}>
                  复制 Markdown
                </button>
                <button className="btn btn--primary btn--sm" onClick={download}>
                  下载课程 (.md)
                </button>
              </div>
            </div>
          </section>
        )}

        {error && (
          <section className="card error-card">
            <h2>⚠️ 出错了</h2>
            <pre className="error-text">{error}</pre>
          </section>
        )}
      </main>

      <footer className="footer">
        <span>
          Powered by <a href="https://github.com/luoguoxiong/aipack" target="_blank" rel="noopener noreferrer">aipack</a>
        </span>
      </footer>
    </>
  );
}
