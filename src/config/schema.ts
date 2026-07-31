import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

export const ChannelsConfigSchema = Type.Object({
  send_progress: Type.Boolean({ default: true }),
  send_tool_hints: Type.Boolean({ default: false }),
  show_reasoning: Type.Boolean({ default: true }),
  extract_document_text: Type.Boolean({ default: true }),
  send_max_retries: Type.Integer({ minimum: 0, maximum: 10, default: 3 }),
  transcription_provider: Type.String({ default: 'groq' }),
  transcription_language: Type.Optional(Type.Union([Type.String({ pattern: '^[a-z]{2,3}$' }), Type.Null()])),
}, { additionalProperties: true });

export type ChannelsConfig = Static<typeof ChannelsConfigSchema>;

export const TranscriptionConfigSchema = Type.Object({
  enabled: Type.Boolean({ default: true }),
  provider: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  model: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  language: Type.Optional(Type.Union([Type.String({ pattern: '^[a-z]{2,3}$' }), Type.Null()])),
  max_duration_sec: Type.Integer({ minimum: 1, maximum: 600, default: 120 }),
  max_upload_mb: Type.Integer({ minimum: 1, maximum: 100, default: 25 }),
});

export type TranscriptionConfig = Static<typeof TranscriptionConfigSchema>;

export const DreamConfigSchema = Type.Object({
  enabled: Type.Boolean({ default: true }),
  interval_h: Type.Integer({ minimum: 1, default: 2 }),
  cron: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  model_override: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  max_batch_size: Type.Integer({ minimum: 1, default: 20 }),
  max_iterations: Type.Integer({ minimum: 1, default: 15 }),
  annotate_line_ages: Type.Boolean({ default: true }),
});

export type DreamConfig = Static<typeof DreamConfigSchema>;

export const InlineFallbackConfigSchema = Type.Object({
  model: Type.String(),
  provider: Type.String(),
  max_tokens: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
  context_window_tokens: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
  temperature: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  reasoning_effort: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

export type InlineFallbackConfig = Static<typeof InlineFallbackConfigSchema>;

export const FallbackCandidateSchema = Type.Union([
  Type.String(),
  InlineFallbackConfigSchema,
]);

export type FallbackCandidate = Static<typeof FallbackCandidateSchema>;

export const ModelPresetConfigSchema = Type.Object({
  label: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  model: Type.String(),
  provider: Type.String({ default: 'auto' }),
  max_tokens: Type.Integer({ default: 8192 }),
  context_window_tokens: Type.Integer({ default: 200000 }),
  temperature: Type.Number({ default: 0.1 }),
  reasoning_effort: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

export type ModelPresetConfig = Static<typeof ModelPresetConfigSchema>;

export const AgentDefaultsSchema = Type.Object({
  workspace: Type.String({ default: '.' }),
  model_preset: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  model: Type.String({ default: 'deepseek-v4-flash' }),
  provider: Type.String({ default: 'auto' }),
  max_tokens: Type.Integer({ default: 8192 }),
  context_window_tokens: Type.Integer({ default: 200000 }),
  context_block_limit: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
  temperature: Type.Number({ default: 0.1 }),
  fallback_models: Type.Array(FallbackCandidateSchema, { default: [] }),
  max_tool_iterations: Type.Integer({ default: 200 }),
  max_concurrent_subagents: Type.Integer({ minimum: 1, default: 1 }),
  fail_on_tool_error: Type.Boolean({ default: true }),
  max_tool_result_chars: Type.Integer({ default: 16000 }),
  provider_retry_mode: Type.Union([Type.Literal('standard'), Type.Literal('persistent')], { default: 'standard' }),
  tool_hint_max_length: Type.Integer({ minimum: 20, maximum: 500, default: 40 }),
  reasoning_effort: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  timezone: Type.String({ default: 'UTC' }),
  bot_name: Type.String({ default: 'kobot' }),
  bot_icon: Type.String({ default: 'image/logo.png' }),
  unified_session: Type.Boolean({ default: false }),
  disabled_skills: Type.Array(Type.String(), { default: [] }),
});

export type AgentDefaults = Static<typeof AgentDefaultsSchema>;

export const AgentsConfigSchema = Type.Object({
  defaults: AgentDefaultsSchema,
  model_presets: Type.Record(Type.String(), ModelPresetConfigSchema, { default: {} }),
  instances: Type.Record(Type.String(), Type.Partial(AgentDefaultsSchema), { default: {} }),
});

export type AgentsConfig = Static<typeof AgentsConfigSchema>;

export const ProviderConfigSchema = Type.Object({
  name: Type.String(),
  base_url: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  api_key: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  api_base: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  default_model: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  extra_headers: Type.Record(Type.String(), Type.String(), { default: {} }),
  extra_query: Type.Record(Type.String(), Type.String(), { default: {} }),
  extra_body: Type.Record(Type.String(), Type.Unknown(), { default: {} }),
}, { additionalProperties: true });

export type ProviderConfig = Static<typeof ProviderConfigSchema>;

export const ProvidersConfigSchema = Type.Object({
  defaults: Type.Object({}, { additionalProperties: true, default: {} }),
  items: Type.Array(ProviderConfigSchema, { default: [] }),
}, { additionalProperties: true });

export type ProvidersConfig = Static<typeof ProvidersConfigSchema>;

export const FileToolsConfigSchema = Type.Object({
  enabled: Type.Boolean({ default: true }),
  workspace_only: Type.Boolean({ default: true }),
  allowed_patterns: Type.Array(Type.String(), { default: [] }),
  denied_patterns: Type.Array(Type.String(), { default: [] }),
  max_file_size_mb: Type.Number({ default: 10 }),
}, { default: {} });

export type FileToolsConfig = Static<typeof FileToolsConfigSchema>;

export const ExecToolConfigSchema = Type.Object({
  enabled: Type.Boolean({ default: true }),
  workspace_only: Type.Boolean({ default: true }),
  allowed_patterns: Type.Array(Type.String(), { default: [] }),
  denied_patterns: Type.Array(Type.String(), { default: [] }),
  timeout_sec: Type.Integer({ default: 120 }),
  shell: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  sandbox_backend: Type.Union([Type.Literal('none'), Type.Literal('docker')], { default: 'none' }),
}, { default: {} });

export type ExecToolConfig = Static<typeof ExecToolConfigSchema>;

export const WebToolsConfigSchema = Type.Object({
  enabled: Type.Boolean({ default: true }),
  search_provider: Type.String({ default: 'ddg' }),
  fetch_timeout_sec: Type.Integer({ default: 30 }),
  max_search_results: Type.Integer({ default: 5 }),
  user_agent: Type.Optional(Type.Union([Type.String(), Type.Null()])),
}, { default: {} });

export type WebToolsConfig = Static<typeof WebToolsConfigSchema>;

export const ImageGenerationToolConfigSchema = Type.Object({
  enabled: Type.Boolean({ default: true }),
  provider: Type.String({ default: 'auto' }),
  model: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  size: Type.String({ default: '1024x1024' }),
  quality: Type.String({ default: 'standard' }),
}, { default: {} });

export type ImageGenerationToolConfig = Static<typeof ImageGenerationToolConfigSchema>;

export const MCPToolConfigSchema = Type.Object({
  enabled: Type.Boolean({ default: true }),
  servers: Type.Record(Type.String(), Type.Unknown(), { default: {} }),
}, { default: {} });

export type MCPToolConfig = Static<typeof MCPToolConfigSchema>;

export const MyToolConfigSchema = Type.Object({
  enabled: Type.Boolean({ default: true }),
}, { default: {} });

export type MyToolConfig = Static<typeof MyToolConfigSchema>;

export const CliAppsToolConfigSchema = Type.Object({
  enabled: Type.Boolean({ default: true }),
  apps: Type.Record(Type.String(), Type.Unknown(), { default: {} }),
}, { default: {} });

export type CliAppsToolConfig = Static<typeof CliAppsToolConfigSchema>;

export const ToolsConfigSchema = Type.Object({
  filesystem: Type.Optional(FileToolsConfigSchema),
  shell: Type.Optional(ExecToolConfigSchema),
  web: Type.Optional(WebToolsConfigSchema),
  image_generation: Type.Optional(ImageGenerationToolConfigSchema),
  mcp: Type.Optional(MCPToolConfigSchema),
  my: Type.Optional(MyToolConfigSchema),
  cli_apps: Type.Optional(CliAppsToolConfigSchema),
}, { additionalProperties: true });

export type ToolsConfig = {
  filesystem: FileToolsConfig;
  shell: ExecToolConfig;
  web: WebToolsConfig;
  image_generation: ImageGenerationToolConfig;
  mcp: MCPToolConfig;
  my: MyToolConfig;
  cli_apps: CliAppsToolConfig;
  [key: string]: unknown;
};

export const MemoryConfigSchema = Type.Object({
  enabled: Type.Boolean({ default: true }),
  base_dir: Type.String({ default: 'memory' }),
  dream: Type.Optional(DreamConfigSchema),
}, { default: {} });

export type MemoryConfig = {
  enabled: boolean;
  base_dir: string;
  dream: DreamConfig;
};

export const CronConfigSchema = Type.Object({
  enabled: Type.Boolean({ default: true }),
  timezone: Type.String({ default: 'UTC' }),
}, { default: {} });

export type CronConfig = {
  enabled: boolean;
  timezone: string;
};

export const GatewayConfigSchema = Type.Object({
  enabled: Type.Boolean({ default: true }),
  host: Type.String({ default: '127.0.0.1' }),
  port: Type.Integer({ default: 8765 }),
  cors_origins: Type.Array(Type.String(), { default: ['http://localhost:5173'] }),
  auth_token: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  webui_path: Type.Optional(Type.Union([Type.String(), Type.Null()])),
}, { default: {} });

export type GatewayConfig = {
  enabled: boolean;
  host: string;
  port: number;
  cors_origins: string[];
  auth_token?: string | null;
  webui_path?: string | null;
};

export const ApiConfigSchema = Type.Object({
  enabled: Type.Boolean({ default: false }),
  host: Type.String({ default: '127.0.0.1' }),
  port: Type.Integer({ default: 8000 }),
  api_keys: Type.Array(Type.String(), { default: [] }),
  cors_origins: Type.Array(Type.String(), { default: [] }),
}, { default: {} });

export type ApiConfig = {
  enabled: boolean;
  host: string;
  port: number;
  api_keys: string[];
  cors_origins: string[];
};

export const SecurityConfigSchema = Type.Object({
  workspace_access: Type.Union([Type.Literal('allow'), Type.Literal('deny'), Type.Literal('ask')], { default: 'allow' }),
  network_access: Type.Boolean({ default: true }),
  pth_guard: Type.Boolean({ default: true }),
});

export type SecurityConfig = Static<typeof SecurityConfigSchema>;

export const SessionsConfigSchema = Type.Object({
  storage: Type.Union([Type.Literal('memory'), Type.Literal('file')], { default: 'memory' }),
  storage_path: Type.String({ default: 'sessions' }),
});

export type SessionsConfig = Static<typeof SessionsConfigSchema>;

export const LoggingConfigSchema = Type.Object({
  level: Type.Union([Type.Literal('trace'), Type.Literal('debug'), Type.Literal('info'), Type.Literal('warn'), Type.Literal('error'), Type.Literal('fatal')], { default: 'info' }),
  file_path: Type.String({ default: 'logs/kobot.log' }),
  console_enabled: Type.Boolean({ default: true }),
  rotation: Type.Optional(Type.Object({
    enabled: Type.Boolean({ default: true }),
    max_size: Type.String({ default: '10M' }),
    max_files: Type.Integer({ minimum: 1, default: 30 }),
    compress: Type.Boolean({ default: true }),
  })),
  separate_error_log: Type.Boolean({ default: true }),
}, { default: {} });

export type LoggingConfig = {
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  file_path: string;
  console_enabled: boolean;
  rotation: {
    enabled: boolean;
    max_size: string;
    max_files: number;
    compress: boolean;
  };
  separate_error_log: boolean;
};

export const ProgressGuardConfigSchema = Type.Object({
  enabled: Type.Boolean({ default: true }),
  profile: Type.Union([Type.Literal('coding'), Type.Literal('research'), Type.Literal('assistant'), Type.Literal('workflow')], { default: 'assistant' }),
  window_size: Type.Integer({ minimum: 5, maximum: 100, default: 20 }),
  min_turns_before_detect: Type.Integer({ minimum: 1, default: 3 }),
  suspicious_threshold: Type.Number({ minimum: 0, maximum: 1, default: 0.4 }),
  stuck_threshold: Type.Number({ minimum: 0, maximum: 1, default: 0.7 }),
  failed_threshold: Type.Number({ minimum: 0, maximum: 1, default: 0.9 }),
  confirmation_turns: Type.Integer({ minimum: 1, default: 2 }),
  downgrade_turns: Type.Integer({ minimum: 1, default: 3 }),
  debug: Type.Boolean({ default: false }),
}, { additionalProperties: true, default: {} });

export type ProgressGuardConfig = {
  enabled: boolean;
  profile: 'coding' | 'research' | 'assistant' | 'workflow';
  window_size: number;
  min_turns_before_detect: number;
  suspicious_threshold: number;
  stuck_threshold: number;
  failed_threshold: number;
  confirmation_turns: number;
  downgrade_turns: number;
  debug: boolean;
  [key: string]: unknown;
};

export const ContextRuntimeConfigSchema = Type.Object({
  enabled: Type.Boolean({ default: true }),
  profile: Type.Union([Type.Literal('coding'), Type.Literal('research'), Type.Literal('assistant')], { default: 'coding' }),
  context_limit: Type.Integer({ minimum: 1000, default: 128000 }),
  debug: Type.Boolean({ default: false }),
}, { additionalProperties: true, default: {} });

export type ContextRuntimeConfig = {
  enabled: boolean;
  profile: 'coding' | 'research' | 'assistant';
  context_limit: number;
  debug: boolean;
  [key: string]: unknown;
};

export const ConfigSchema = Type.Object({
  schema_version: Type.Integer({ default: 1 }),
  workspace: Type.String({ default: '~/.kobot' }),
  workspace_resolved: Type.Optional(Type.String()),
  agents: AgentsConfigSchema,
  providers: Type.Optional(ProvidersConfigSchema),
  channels: Type.Optional(ChannelsConfigSchema),
  tools: Type.Optional(ToolsConfigSchema),
  memory: Type.Optional(MemoryConfigSchema),
  transcription: Type.Optional(TranscriptionConfigSchema),
  cron: Type.Optional(CronConfigSchema),
  gateway: Type.Optional(GatewayConfigSchema),
  api: Type.Optional(ApiConfigSchema),
  security: Type.Optional(SecurityConfigSchema),
  sessions: Type.Optional(SessionsConfigSchema),
  logging: Type.Optional(LoggingConfigSchema),
  progress_guard: Type.Optional(ProgressGuardConfigSchema),
  context_runtime: Type.Optional(ContextRuntimeConfigSchema),
}, { additionalProperties: true });

export type Config = {
  schema_version: number;
  workspace: string;
  workspace_resolved?: string;
  agents: AgentsConfig;
  providers: ProvidersConfig;
  channels: ChannelsConfig;
  tools: ToolsConfig;
  memory: MemoryConfig;
  transcription: TranscriptionConfig;
  cron: CronConfig;
  gateway: GatewayConfig;
  api: ApiConfig;
  security: SecurityConfig;
  sessions: SessionsConfig;
  logging: LoggingConfig;
  progress_guard: ProgressGuardConfig;
  context_runtime: ContextRuntimeConfig;
  [key: string]: unknown;
};

export function defaultConfig(): Config {
  return Value.Decode(ConfigSchema, {
    agents: {
      defaults: {},
      model_presets: {},
      instances: {},
    },
  }) as Config;
}
