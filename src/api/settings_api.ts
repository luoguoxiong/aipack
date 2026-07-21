import { loadConfig, saveConfig, getConfigPath } from '../config/loader.js';
import { Config, ProviderConfig } from '../config/schema.js';
import { getProjectConfigDir } from '../config/paths.js';
import { logger } from '../utils/logger.js';
import { tokenUsagePayload } from '../webui/token_usage.js';

const WEB_SEARCH_PROVIDER_OPTIONS = [
  { name: 'duckduckgo', label: 'DuckDuckGo', credential: 'none' },
  { name: 'serper', label: 'Serper', credential: 'api_key' },
];

const CONTEXT_WINDOW_TOKEN_OPTIONS = new Set([65_536, 200_000, 262_144]);

interface SettingsPayload {
  surface: string;
  runtime_surface: string;
  runtime_capabilities: {
    can_export_diagnostics: boolean;
    can_open_logs: boolean;
    can_pick_folder: boolean;
    can_restart_engine: boolean;
  };
  restart_behavior_by_section: Record<string, string>;
  restart_required_sections: string[];
  requires_restart: boolean;
  apply_state: {
    status: string;
    sections: string[];
  };
  agent: {
    model: string;
    provider: string;
    resolved_provider: string;
    has_api_key: boolean;
    model_preset: string | null;
    max_tokens: number;
    context_window_tokens: number;
    temperature: number;
    reasoning_effort: string | null;
    reasoning_effort_values: string[];
    timezone: string;
    bot_name: string;
    bot_icon: string;
    tool_hint_max_length: number;
  };
  model_presets: Array<{
    name: string;
    label: string;
    active: boolean;
    is_default: boolean;
    model: string;
    provider: string;
    max_tokens: number;
    context_window_tokens: number;
    temperature: number;
    reasoning_effort: string | null;
    reasoning_effort_values: string[];
  }>;
  providers: Array<{
    name: string;
    label: string;
    configured: boolean;
    auth_type: 'api_key' | 'oauth';
    api_key_required: boolean;
    api_key_hint: string | null;
    api_base: string | null;
    default_api_base: string | null;
    model_selectable: boolean;
    model_catalog: string;
  }>;
  web_search: {
    provider: string;
    api_key_hint: string | null;
    base_url: string | null;
    max_results: number;
    timeout: number;
    providers: typeof WEB_SEARCH_PROVIDER_OPTIONS;
  };
  web: {
    enable: boolean;
    proxy: string | null;
    user_agent: string | null;
    search: { max_results: number; timeout: number };
    fetch: { use_jina_reader: boolean };
  };
  api: {
    host: string;
    port: number;
    timeout: number;
    api_key_hint: string | null;
  };
  observability: {
    provider: string;
    configured: boolean;
    base_url: string;
  };
  image_generation: {
    enabled: boolean;
    provider: string;
    provider_configured: boolean;
    model: string | null;
    default_aspect_ratio: string;
    default_image_size: string;
    max_images_per_turn: number;
    save_dir: string;
    providers: Array<{
      name: string;
      label: string;
      configured: boolean;
      auth_type: 'api_key' | 'oauth';
      api_key_hint: string | null;
      api_base: string | null;
      default_api_base: string | null;
    }>;
  };
  transcription: {
    enabled: boolean;
    provider: string | null;
    provider_configured: boolean;
    model: string | null;
    language: string | null;
    max_duration_sec: number;
    max_upload_mb: number;
    providers: Array<{
      name: string;
      label: string;
      configured: boolean;
      api_key_hint: string | null;
      api_base: string | null;
      default_api_base: string | null;
    }>;
  };
  runtime: {
    config_path: string;
    workspace_path: string;
    gateway_host: string;
    gateway_port: number;
    heartbeat: {
      enabled: boolean;
      interval_s: number;
      keep_recent_messages: number;
    };
    dream: {
      schedule: string;
    };
    unified_session: boolean;
  };
  usage: ReturnType<typeof tokenUsagePayload>;
  advanced: {
    restrict_to_workspace: boolean;
    workspace_sandbox: {
      restrict_to_workspace: boolean;
      workspace_root: string;
      level: string;
      enforced: boolean;
      provider: string;
      provider_label: string;
      summary: string;
    };
    webui_allow_local_service_access: boolean;
    allow_local_preview_access: boolean;
    webui_default_access_mode: string;
    private_service_protection_enabled: boolean;
    ssrf_whitelist_count: number;
    mcp_server_count: number;
    exec_enabled: boolean;
    exec_sandbox: string | null;
    exec_path_prepend_set: boolean;
    exec_path_append_set: boolean;
  };
  version: {
    current: string;
  };
  docs: {
    version: string;
    base_url: string;
    chat_apps_url: string;
    latest_url: string;
  };
  mcp_presets: { presets: Array<Record<string, unknown>> };
  channels: Array<Record<string, unknown>>;
  cli_apps: { apps: Array<Record<string, unknown>> };
  automations: { jobs: Array<Record<string, unknown>> };
  nanobot_features: { features: Array<Record<string, unknown>> };
  pairing: { requests: Array<Record<string, unknown>> };
}

function maskSecret(secret: string | null | undefined): string | null {
  if (!secret) return null;
  const s = String(secret);
  if (s.length <= 8) return '••••';
  return `••••${s.slice(-4)}`;
}

function resolveSettingsProvider(config: Config, providerName: string): ProviderConfig | null {
  return config.providers.items.find(p => p.name === providerName) || null;
}

function providerConfigured(provider: ProviderConfig | null): boolean {
  if (!provider) return false;
  return !!provider.api_key || !!provider.base_url || !!provider.api_base;
}

function resolvedProviderName(config: Config): string {
  const provider = config.agents.defaults.provider;
  if (provider !== 'auto') return provider;
  const model = config.agents.defaults.model;
  if (model.includes('/')) {
    return model.split('/')[0];
  }
  const firstProvider = config.providers.items[0];
  return firstProvider?.name || provider;
}

function modelPresetsFromConfig(config: Config): SettingsPayload['model_presets'] {
  const presets: SettingsPayload['model_presets'] = [];
  const activePresetName = config.agents.defaults.model_preset || 'default';
  
  presets.push({
    name: 'default',
    label: 'Default',
    active: activePresetName === 'default',
    is_default: true,
    model: config.agents.defaults.model,
    provider: config.agents.defaults.provider,
    max_tokens: config.agents.defaults.max_tokens,
    context_window_tokens: config.agents.defaults.context_window_tokens,
    temperature: config.agents.defaults.temperature,
    reasoning_effort: config.agents.defaults.reasoning_effort || null,
    reasoning_effort_values: ['', 'low', 'medium', 'high'],
  });

  for (const [name, preset] of Object.entries(config.agents.model_presets)) {
    presets.push({
      name,
      label: preset.label || name,
      active: activePresetName === name,
      is_default: false,
      model: preset.model,
      provider: preset.provider,
      max_tokens: preset.max_tokens,
      context_window_tokens: preset.context_window_tokens,
      temperature: preset.temperature,
      reasoning_effort: preset.reasoning_effort || null,
      reasoning_effort_values: ['', 'low', 'medium', 'high'],
    });
  }

  return presets;
}

function providersFromConfig(config: Config): SettingsPayload['providers'] {
  return config.providers.items.map(p => ({
    name: p.name,
    label: p.name,
    configured: providerConfigured(p),
    auth_type: 'api_key' as const,
    api_key_required: true,
    api_key_hint: maskSecret(p.api_key),
    api_base: p.api_base || p.base_url || null,
    default_api_base: null,
    model_selectable: true,
    model_catalog: 'custom',
  }));
}

function webSearchFromConfig(config: Config): SettingsPayload['web_search'] {
  const web = config.tools.web;
  const searchProvider = web.search_provider === 'ddg' ? 'duckduckgo' : web.search_provider;
  return {
    provider: searchProvider,
    api_key_hint: null,
    base_url: null,
    max_results: web.max_search_results,
    timeout: web.fetch_timeout_sec,
    providers: WEB_SEARCH_PROVIDER_OPTIONS,
  };
}

function webFromConfig(config: Config): SettingsPayload['web'] {
  const web = config.tools.web;
  return {
    enable: web.enabled,
    proxy: null,
    user_agent: web.user_agent || null,
    search: {
      max_results: web.max_search_results,
      timeout: web.fetch_timeout_sec,
    },
    fetch: { use_jina_reader: false },
  };
}

function runtimeFromConfig(config: Config): SettingsPayload['runtime'] {
  const dream = config.memory.dream;
  const schedule = dream.cron || `every ${dream.interval_h}h`;
  return {
    config_path: getConfigPath(),
    workspace_path: config.agents.defaults.workspace,
    gateway_host: config.gateway.host,
    gateway_port: config.gateway.port,
    heartbeat: {
      enabled: true,
      interval_s: 30,
      keep_recent_messages: 50,
    },
    dream: { schedule },
    unified_session: config.agents.defaults.unified_session,
  };
}

function advancedFromConfig(config: Config): SettingsPayload['advanced'] {
  return {
    restrict_to_workspace: config.tools.filesystem.workspace_only,
    workspace_sandbox: {
      restrict_to_workspace: config.tools.filesystem.workspace_only,
      workspace_root: config.agents.defaults.workspace,
      level: 'off',
      enforced: false,
      provider: 'none',
      provider_label: 'None',
      summary: 'No sandbox restrictions',
    },
    webui_allow_local_service_access: true,
    allow_local_preview_access: true,
    webui_default_access_mode: 'default',
    private_service_protection_enabled: false,
    ssrf_whitelist_count: 0,
    mcp_server_count: Object.keys(config.tools.mcp.servers || {}).length,
    exec_enabled: config.tools.shell.enabled,
    exec_sandbox: config.tools.shell.sandbox_backend === 'none' ? null : config.tools.shell.sandbox_backend,
    exec_path_prepend_set: false,
    exec_path_append_set: false,
  };
}

function docsPayload(): SettingsPayload['docs'] {
  const version = 'latest';
  const baseUrl = `https://nanobot.wiki/docs/${version}`;
  return {
    version,
    base_url: baseUrl,
    chat_apps_url: `${baseUrl}/getting-started/chat-apps`,
    latest_url: 'https://nanobot.wiki/docs/latest',
  };
}

function apiPayload(config: Config): SettingsPayload['api'] {
  return {
    host: config.api.host,
    port: config.api.port,
    timeout: 60,
    api_key_hint: config.api.api_keys.length > 0 ? 'configured' : null,
  };
}

function observabilityPayload(): SettingsPayload['observability'] {
  return {
    provider: 'langfuse',
    configured: !!(process.env.LANGFUSE_SECRET_KEY && process.env.LANGFUSE_PUBLIC_KEY),
    base_url: process.env.LANGFUSE_BASE_URL || 'https://cloud.langfuse.com',
  };
}

function imageGenerationPayload(config: Config): SettingsPayload['image_generation'] {
  const imageGen = config.tools.image_generation;
  return {
    enabled: imageGen.enabled,
    provider: imageGen.provider,
    provider_configured: false,
    model: imageGen.model ?? null,
    default_aspect_ratio: '1:1',
    default_image_size: imageGen.size || '1024x1024',
    max_images_per_turn: 1,
    save_dir: '',
    providers: [],
  };
}

function transcriptionPayload(config: Config): SettingsPayload['transcription'] {
  const transcription = config.transcription;
  return {
    enabled: transcription.enabled,
    provider: transcription.provider ?? null,
    provider_configured: false,
    model: transcription.model ?? null,
    language: transcription.language ?? null,
    max_duration_sec: transcription.max_duration_sec,
    max_upload_mb: transcription.max_upload_mb,
    providers: [],
  };
}

export async function settingsPayload(
  options: {
    requires_restart?: boolean;
    restart_required_sections?: string[];
  } = {},
): Promise<SettingsPayload> {
  const config = await loadConfig();
  const sections = options.restart_required_sections || [];
  const requiresRestart = options.requires_restart || sections.length > 0;

  return {
    surface: 'browser',
    runtime_surface: 'browser',
    runtime_capabilities: {
      can_export_diagnostics: false,
      can_open_logs: false,
      can_pick_folder: false,
      can_restart_engine: false,
    },
    restart_behavior_by_section: {
      appearance: 'none',
      models: 'none',
      providers: 'none',
      runtime: 'engineRestart',
      browser: 'engineRestart',
      image: 'engineRestart',
      apps: 'engineRestart',
      advanced: 'appRestart',
    },
    restart_required_sections: sections,
    requires_restart: requiresRestart,
    apply_state: {
      status: requiresRestart ? 'pending' : 'idle',
      sections,
    },
    agent: {
      model: config.agents.defaults.model,
      provider: config.agents.defaults.provider,
      resolved_provider: resolvedProviderName(config),
      has_api_key: config.providers.items.some(p => !!p.api_key),
      model_preset: config.agents.defaults.model_preset || null,
      max_tokens: config.agents.defaults.max_tokens,
      context_window_tokens: config.agents.defaults.context_window_tokens,
      temperature: config.agents.defaults.temperature,
      reasoning_effort: config.agents.defaults.reasoning_effort || null,
      reasoning_effort_values: ['', 'low', 'medium', 'high'],
      timezone: config.agents.defaults.timezone,
      bot_name: config.agents.defaults.bot_name,
      bot_icon: config.agents.defaults.bot_icon,
      tool_hint_max_length: config.agents.defaults.tool_hint_max_length,
    },
    model_presets: modelPresetsFromConfig(config),
    providers: providersFromConfig(config),
    web_search: webSearchFromConfig(config),
    web: webFromConfig(config),
    api: apiPayload(config),
    observability: observabilityPayload(),
    image_generation: imageGenerationPayload(config),
    transcription: transcriptionPayload(config),
    runtime: runtimeFromConfig(config),
    usage: tokenUsagePayload({ timezoneName: config.agents.defaults.timezone }),
    advanced: advancedFromConfig(config),
    version: { current: '0.1.0' },
    docs: docsPayload(),
    mcp_presets: { presets: [] },
    channels: [],
    cli_apps: { apps: [] },
    automations: { jobs: [] },
    nanobot_features: { features: [] },
    pairing: { requests: [] },
  };
}

export async function settingsUsagePayload(): Promise<ReturnType<typeof tokenUsagePayload>> {
  const config = await loadConfig();
  return tokenUsagePayload({ timezoneName: config.agents.defaults.timezone });
}

export async function updateAgentSettings(query: Record<string, string>): Promise<SettingsPayload> {
  const config = await loadConfig();
  let changed = false;
  let restartRequired = false;

  if (query.model_preset !== undefined) {
    const preset = query.model_preset.trim();
    const presetValue = preset === 'default' ? null : preset;
    if (config.agents.defaults.model_preset !== presetValue) {
      config.agents.defaults.model_preset = presetValue;
      changed = true;
    }
  }

  if (query.model !== undefined) {
    const model = query.model.trim();
    if (model && config.agents.defaults.model !== model) {
      config.agents.defaults.model = model;
      changed = true;
    }
  }

  if (query.provider !== undefined) {
    const provider = query.provider.trim();
    if (provider && config.agents.defaults.provider !== provider) {
      config.agents.defaults.provider = provider;
      changed = true;
    }
  }

  if (query.context_window_tokens !== undefined) {
    const tokens = parseInt(query.context_window_tokens, 10);
    if (!isNaN(tokens) && CONTEXT_WINDOW_TOKEN_OPTIONS.has(tokens) && config.agents.defaults.context_window_tokens !== tokens) {
      config.agents.defaults.context_window_tokens = tokens;
      changed = true;
    }
  }

  if (query.timezone !== undefined) {
    const timezone = query.timezone.trim();
    if (timezone && config.agents.defaults.timezone !== timezone) {
      config.agents.defaults.timezone = timezone;
      changed = true;
      restartRequired = true;
    }
  }

  if (query.bot_name !== undefined) {
    const botName = query.bot_name.trim();
    if (botName && config.agents.defaults.bot_name !== botName) {
      config.agents.defaults.bot_name = botName;
      changed = true;
      restartRequired = true;
    }
  }

  if (query.bot_icon !== undefined) {
    const botIcon = query.bot_icon.trim();
    if (config.agents.defaults.bot_icon !== botIcon) {
      config.agents.defaults.bot_icon = botIcon;
      changed = true;
      restartRequired = true;
    }
  }

  if (query.tool_hint_max_length !== undefined) {
    const length = parseInt(query.tool_hint_max_length, 10);
    if (!isNaN(length) && length >= 20 && length <= 500 && config.agents.defaults.tool_hint_max_length !== length) {
      config.agents.defaults.tool_hint_max_length = length;
      changed = true;
      restartRequired = true;
    }
  }

  if (changed) {
    await saveConfig(config);
  }

  return settingsPayload({ requires_restart: restartRequired, restart_required_sections: restartRequired ? ['runtime'] : [] });
}

export async function createModelConfiguration(query: Record<string, string>): Promise<SettingsPayload> {
  const config = await loadConfig();
  const label = query.label?.trim() || '';
  const name = query.name?.trim() || label;
  const model = query.model?.trim() || '';
  const provider = query.provider?.trim() || '';

  if (!model || !provider) {
    throw new Error('model and provider are required');
  }

  const slug = name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-|-$/g, '') || 'custom';
  if (slug === 'default') {
    throw new Error('configuration name is reserved');
  }
  if (config.agents.model_presets[slug]) {
    throw new Error('configuration already exists');
  }

  const basePreset = config.agents.defaults;
  config.agents.model_presets[slug] = {
    label: label || name,
    model,
    provider,
    max_tokens: basePreset.max_tokens,
    context_window_tokens: basePreset.context_window_tokens,
    temperature: basePreset.temperature,
    reasoning_effort: basePreset.reasoning_effort || undefined,
  };
  config.agents.defaults.model_preset = slug;

  await saveConfig(config);
  return settingsPayload();
}

export async function updateModelConfiguration(query: Record<string, string>): Promise<SettingsPayload> {
  const config = await loadConfig();
  const name = query.name?.trim();

  if (!name || name === 'default') {
    throw new Error('model configuration is required');
  }

  const preset = config.agents.model_presets[name];
  if (!preset) {
    throw new Error('unknown model configuration');
  }

  let changed = false;

  if (query.label !== undefined) {
    const label = query.label.trim();
    if (label && preset.label !== label) {
      preset.label = label;
      changed = true;
    }
  }

  if (query.model !== undefined) {
    const model = query.model.trim();
    if (model && preset.model !== model) {
      preset.model = model;
      changed = true;
    }
  }

  if (query.provider !== undefined) {
    const provider = query.provider.trim();
    if (provider && preset.provider !== provider) {
      preset.provider = provider;
      changed = true;
    }
  }

  if (query.context_window_tokens !== undefined) {
    const tokens = parseInt(query.context_window_tokens, 10);
    if (!isNaN(tokens) && CONTEXT_WINDOW_TOKEN_OPTIONS.has(tokens) && preset.context_window_tokens !== tokens) {
      preset.context_window_tokens = tokens;
      changed = true;
    }
  }

  if (config.agents.defaults.model_preset !== name) {
    config.agents.defaults.model_preset = name;
    changed = true;
  }

  if (changed) {
    await saveConfig(config);
  }

  return settingsPayload();
}

export async function updateProviderSettings(query: Record<string, string>): Promise<SettingsPayload> {
  const config = await loadConfig();
  const providerName = query.provider?.trim();

  if (!providerName) {
    throw new Error('provider is required');
  }

  let provider = config.providers.items.find(p => p.name === providerName);
  if (!provider) {
    provider = {
      name: providerName,
      api_key: undefined,
      base_url: undefined,
      api_base: undefined,
      default_model: undefined,
      extra_headers: {},
      extra_query: {},
      extra_body: {},
    };
    config.providers.items.push(provider);
  }

  let changed = false;

  if (query.api_key !== undefined) {
    const apiKey = query.api_key.trim() || undefined;
    if (provider.api_key !== apiKey) {
      provider.api_key = apiKey;
      changed = true;
    }
  }

  if (query.api_base !== undefined) {
    const apiBase = query.api_base.trim() || undefined;
    if (provider.api_base !== apiBase) {
      provider.api_base = apiBase;
      changed = true;
    }
  }

  if (query.api_type !== undefined) {
    const apiType = query.api_type.trim();
    if (['auto', 'chat_completions', 'responses'].includes(apiType)) {
      (provider as Record<string, unknown>).api_type = apiType;
      changed = true;
    }
  }

  if (changed) {
    await saveConfig(config);
  }

  return settingsPayload({ requires_restart: changed ? true : undefined, restart_required_sections: changed ? ['image'] : [] });
}

export async function updateWebSearchSettings(query: Record<string, string>): Promise<SettingsPayload> {
  const config = await loadConfig();
  const web = config.tools.web;

  let changed = false;
  let restartRequired = false;

  if (query.provider !== undefined) {
    const provider = query.provider.trim().toLowerCase();
    if (provider && web.search_provider !== provider) {
      web.search_provider = provider === 'duckduckgo' ? 'ddg' : provider;
      changed = true;
    }
  }

  if (query.max_results !== undefined) {
    const maxResults = parseInt(query.max_results, 10);
    if (!isNaN(maxResults) && maxResults >= 1 && maxResults <= 10 && web.max_search_results !== maxResults) {
      web.max_search_results = maxResults;
      changed = true;
    }
  }

  if (query.timeout !== undefined) {
    const timeout = parseInt(query.timeout, 10);
    if (!isNaN(timeout) && timeout >= 1 && timeout <= 60 && web.fetch_timeout_sec !== timeout) {
      web.fetch_timeout_sec = timeout;
      changed = true;
    }
  }

  if (query.use_jina_reader !== undefined) {
    const useJina = query.use_jina_reader === 'true';
    restartRequired = true;
    changed = true;
  }

  if (changed) {
    await saveConfig(config);
  }

  return settingsPayload({ requires_restart: restartRequired, restart_required_sections: restartRequired ? ['browser'] : [] });
}

export async function updateNetworkSafetySettings(query: Record<string, string>): Promise<SettingsPayload> {
  const config = await loadConfig();

  let changed = false;

  if (query.webui_allow_local_service_access !== undefined) {
    const allow = query.webui_allow_local_service_access === 'true';
    changed = true;
  }

  if (query.webui_default_access_mode !== undefined) {
    const mode = query.webui_default_access_mode.trim().toLowerCase();
    if (mode === 'default' || mode === 'full') {
      changed = true;
    }
  }

  if (changed) {
    await saveConfig(config);
  }

  return settingsPayload({ requires_restart: changed, restart_required_sections: changed ? ['runtime'] : [] });
}

export async function updateImageGenerationSettings(query: Record<string, string>): Promise<SettingsPayload> {
  const config = await loadConfig();
  const imageGen = config.tools.image_generation;

  let changed = false;

  if (query.enabled !== undefined) {
    const enabled = query.enabled === 'true';
    if (imageGen.enabled !== enabled) {
      imageGen.enabled = enabled;
      changed = true;
    }
  }

  if (query.provider !== undefined) {
    const provider = query.provider.trim();
    if (provider && imageGen.provider !== provider) {
      imageGen.provider = provider;
      changed = true;
    }
  }

  if (query.model !== undefined) {
    const model = query.model.trim();
    if (imageGen.model !== model) {
      imageGen.model = model || undefined;
      changed = true;
    }
  }

  if (query.default_aspect_ratio !== undefined) {
    changed = true;
  }

  if (query.default_image_size !== undefined) {
    const size = query.default_image_size.trim();
    if (imageGen.size !== size) {
      imageGen.size = size;
      changed = true;
    }
  }

  if (query.max_images_per_turn !== undefined) {
    const maxImages = parseInt(query.max_images_per_turn, 10);
    if (!isNaN(maxImages) && maxImages >= 1 && maxImages <= 10) {
      changed = true;
    }
  }

  if (changed) {
    await saveConfig(config);
  }

  return settingsPayload({ requires_restart: changed, restart_required_sections: changed ? ['image'] : [] });
}

export async function updateTranscriptionSettings(query: Record<string, string>): Promise<SettingsPayload> {
  const config = await loadConfig();
  const transcription = config.transcription;

  let changed = false;

  if (query.enabled !== undefined) {
    const enabled = query.enabled === 'true';
    if (transcription.enabled !== enabled) {
      transcription.enabled = enabled;
      changed = true;
    }
  }

  if (query.provider !== undefined) {
    const provider = query.provider.trim();
    if (transcription.provider !== provider) {
      transcription.provider = provider || undefined;
      changed = true;
    }
  }

  if (query.model !== undefined) {
    const model = query.model.trim();
    if (transcription.model !== model) {
      transcription.model = model || undefined;
      changed = true;
    }
  }

  if (query.language !== undefined) {
    const language = query.language.trim();
    if (transcription.language !== language) {
      transcription.language = language || undefined;
      changed = true;
    }
  }

  if (query.max_duration_sec !== undefined) {
    const duration = parseInt(query.max_duration_sec, 10);
    if (!isNaN(duration) && duration >= 1 && duration <= 600 && transcription.max_duration_sec !== duration) {
      transcription.max_duration_sec = duration;
      changed = true;
    }
  }

  if (query.max_upload_mb !== undefined) {
    const mb = parseInt(query.max_upload_mb, 10);
    if (!isNaN(mb) && mb >= 1 && mb <= 100 && transcription.max_upload_mb !== mb) {
      transcription.max_upload_mb = mb;
      changed = true;
    }
  }

  if (changed) {
    await saveConfig(config);
  }

  return settingsPayload({ requires_restart: changed, restart_required_sections: changed ? ['browser'] : [] });
}

export async function providerModelsPayload(query: Record<string, string>): Promise<Record<string, unknown>> {
  const providerName = query.provider?.trim();
  if (!providerName) {
    throw new Error('provider is required');
  }

  return {
    provider: providerName,
    label: providerName,
    catalog_kind: 'manual',
    models: [],
    model_count: 0,
    message: 'Model list is not available for this provider. Type a model ID manually.',
    status: 'unsupported',
    fetched_at: Date.now(),
  };
}