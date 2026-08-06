// apps/ai_teaching_agent_team/frontend/src/components/ConfigBar.tsx
// 顶部配置条:模型下拉(按 provider 分组) + API Key(已配 provider 禁用,未配启用 + localStorage) + 状态条。
// 模型/Key 联动逻辑对齐 apps/ai_travel_agent/public/app.js。
import { useMemo, useState } from 'react';
import type { ServerConfig } from '../api';

interface ConfigBarProps {
  config: ServerConfig;
  modelValue: string;
  onModelChange: (value: string) => void;
  apiKey: string;
  onApiKeyChange: (value: string) => void;
  disabled: boolean;
}

export function ConfigBar({ config, modelValue, onModelChange, apiKey, onApiKeyChange, disabled }: ConfigBarProps) {
  const [showKey, setShowKey] = useState(false);

  // provider → available / envVar 映射
  const { providerAvailable, providerEnvVar } = useMemo(() => {
    const available = new Map<string, boolean>();
    const envVar = new Map<string, string>();
    for (const m of config.models) {
      available.set(m.provider, m.available);
      envVar.set(m.provider, m.envVar);
    }
    return { providerAvailable: available, providerEnvVar: envVar };
  }, [config.models]);

  const currentProvider = modelValue.slice(0, modelValue.indexOf(':')) || config.provider;
  const providerAvailableOnServer = providerAvailable.get(currentProvider) ?? false;
  const envVar = providerEnvVar.get(currentProvider) || `${currentProvider.toUpperCase()}_API_KEY`;

  // 模型下拉分组
  const groups = useMemo(() => {
    const map = new Map<string, { name: string; items: typeof config.models }>();
    for (const m of config.models) {
      if (!map.has(m.provider)) map.set(m.provider, { name: m.providerName, items: [] });
      map.get(m.provider)!.items.push(m);
    }
    return [...map.entries()];
  }, [config.models]);

  // 当前选中模型的可读名(状态条用)
  const currentModelLabel = useMemo(() => {
    const [p, mid] = modelValue.split(':');
    const m = config.models.find((x) => x.provider === p && x.modelId === mid);
    return m?.modelName ?? config.model;
  }, [modelValue, config.models, config.model]);

  const apiKeyFieldDisabled = disabled || providerAvailableOnServer;

  return (
    <section className="card form-card">
      <h2>配置</h2>
      <div className="form-row">
        <label className="field">
          <span>模型</span>
          <select value={modelValue} onChange={(e) => onModelChange(e.target.value)} disabled={disabled}>
            {groups.map(([provider, g]) => (
              <optgroup key={provider} label={g.name}>
                {g.items.map((m) => (
                  <option key={`${m.provider}:${m.modelId}`} value={`${m.provider}:${m.modelId}`}>
                    {m.modelName}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
      </div>
      <div className="form-row">
        <label className="field field--grow">
          <span>
            API Key <span className={`hint ${providerAvailableOnServer ? 'hint--ok' : ''}`}>{providerAvailableOnServer ? '✅ 已用服务器配置' : `需要 ${envVar}`}</span>
          </span>
          <div className="input-with-toggle">
            <input
              type={showKey ? 'text' : 'password'}
              value={providerAvailableOnServer ? '' : apiKey}
              placeholder={providerAvailableOnServer ? '已用服务器配置,无需输入' : `输入 ${envVar}`}
              onChange={(e) => onApiKeyChange(e.target.value)}
              disabled={apiKeyFieldDisabled}
              autoComplete="off"
              spellCheck={false}
            />
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => setShowKey((v) => !v)}
              aria-label="显示/隐藏 API Key"
              disabled={disabled}
            >
              👁
            </button>
          </div>
        </label>
      </div>
      <div className={`status ${config.llmReady ? '' : 'status--warn'}`}>
        模型 {currentModelLabel} · LLM {config.llmReady ? '✅ 已就绪' : '❌ 未配置(请设置 API Key)'} · 搜索:{config.searchBackend}
      </div>
    </section>
  );
}
