import { z } from 'zod';

export const ChannelsConfigSchema = z.object({
  send_progress: z.boolean().default(true),
  send_tool_hints: z.boolean().default(false),
  show_reasoning: z.boolean().default(true),
  extract_document_text: z.boolean().default(true),
  send_max_retries: z.number().int().min(0).max(10).default(3),
  transcription_provider: z.string().default('groq'),
  transcription_language: z.string().regex(/^[a-z]{2,3}$/).optional().nullable(),
}).passthrough();

export type ChannelsConfig = z.infer<typeof ChannelsConfigSchema>;

export const TranscriptionConfigSchema = z.object({
  enabled: z.boolean().default(true),
  provider: z.string().optional().nullable(),
  model: z.string().optional().nullable(),
  language: z.string().regex(/^[a-z]{2,3}$/).optional().nullable(),
  max_duration_sec: z.number().int().min(1).max(600).default(120),
  max_upload_mb: z.number().int().min(1).max(100).default(25),
});

export type TranscriptionConfig = z.infer<typeof TranscriptionConfigSchema>;

export const DreamConfigSchema = z.object({
  enabled: z.boolean().default(true),
  interval_h: z.number().int().min(1).default(2),
  cron: z.string().optional().nullable(),
  model_override: z.string().optional().nullable(),
  max_batch_size: z.number().int().min(1).default(20),
  max_iterations: z.number().int().min(1).default(15),
  annotate_line_ages: z.boolean().default(true),
});

export type DreamConfig = z.infer<typeof DreamConfigSchema>;

export const InlineFallbackConfigSchema = z.object({
  model: z.string(),
  provider: z.string(),
  max_tokens: z.number().int().optional().nullable(),
  context_window_tokens: z.number().int().optional().nullable(),
  temperature: z.number().optional().nullable(),
  reasoning_effort: z.string().optional().nullable(),
});

export type InlineFallbackConfig = z.infer<typeof InlineFallbackConfigSchema>;

export const FallbackCandidateSchema = z.union([
  z.string(),
  InlineFallbackConfigSchema,
]);

export type FallbackCandidate = z.infer<typeof FallbackCandidateSchema>;

export const ModelPresetConfigSchema = z.object({
  label: z.string().optional().nullable(),
  model: z.string(),
  provider: z.string().default('auto'),
  max_tokens: z.number().int().default(8192),
  context_window_tokens: z.number().int().default(200000),
  temperature: z.number().default(0.1),
  reasoning_effort: z.string().optional().nullable(),
});

export type ModelPresetConfig = z.infer<typeof ModelPresetConfigSchema>;

export const AgentDefaultsSchema = z.object({
  workspace: z.string().default('workspace'),
  model_preset: z.string().optional().nullable(),
  model: z.string().default('deepseek-v4-flash'),
  provider: z.string().default('auto'),
  max_tokens: z.number().int().default(8192),
  context_window_tokens: z.number().int().default(200000),
  context_block_limit: z.number().int().optional().nullable(),
  temperature: z.number().default(0.1),
  fallback_models: z.array(FallbackCandidateSchema).default([]),
  max_tool_iterations: z.number().int().default(200),
  max_concurrent_subagents: z.number().int().min(1).default(1),
  fail_on_tool_error: z.boolean().default(true),
  max_tool_result_chars: z.number().int().default(16000),
  provider_retry_mode: z.enum(['standard', 'persistent']).default('standard'),
  tool_hint_max_length: z.number().int().min(20).max(500).default(40),
  reasoning_effort: z.string().optional().nullable(),
  timezone: z.string().default('UTC'),
  bot_name: z.string().default('kobot'),
  bot_icon: z.string().default('image/logo.png'),
  unified_session: z.boolean().default(false),
  disabled_skills: z.array(z.string()).default([]),
});

export type AgentDefaults = z.infer<typeof AgentDefaultsSchema>;

export const AgentsConfigSchema = z.object({
  defaults: AgentDefaultsSchema,
  model_presets: z.record(z.string(), ModelPresetConfigSchema).default({}),
  instances: z.record(z.string(), AgentDefaultsSchema.partial()).default({}),
});

export type AgentsConfig = z.infer<typeof AgentsConfigSchema>;

export const ProviderConfigSchema = z.object({
  name: z.string(),
  base_url: z.string().optional().nullable(),
  api_key: z.string().optional().nullable(),
  api_base: z.string().optional().nullable(),
  default_model: z.string().optional().nullable(),
  extra_headers: z.record(z.string(), z.string()).default({}),
  extra_query: z.record(z.string(), z.string()).default({}),
  extra_body: z.record(z.string(), z.unknown()).default({}),
}).passthrough();

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

export const ProvidersConfigSchema = z.object({
  defaults: z.object({}).passthrough().default({}),
  items: z.array(ProviderConfigSchema).default([]),
}).passthrough();

export type ProvidersConfig = z.infer<typeof ProvidersConfigSchema>;

export const FileToolsConfigSchema = z.object({
  enabled: z.boolean().default(true),
  workspace_only: z.boolean().default(true),
  allowed_patterns: z.array(z.string()).default([]),
  denied_patterns: z.array(z.string()).default([]),
  max_file_size_mb: z.number().default(10),
});

export type FileToolsConfig = z.infer<typeof FileToolsConfigSchema>;

export const ExecToolConfigSchema = z.object({
  enabled: z.boolean().default(true),
  workspace_only: z.boolean().default(true),
  allowed_patterns: z.array(z.string()).default([]),
  denied_patterns: z.array(z.string()).default([]),
  timeout_sec: z.number().int().default(120),
  shell: z.string().optional().nullable(),
  sandbox_backend: z.enum(['none', 'docker']).default('none'),
});

export type ExecToolConfig = z.infer<typeof ExecToolConfigSchema>;

export const WebToolsConfigSchema = z.object({
  enabled: z.boolean().default(true),
  search_provider: z.string().default('ddg'),
  fetch_timeout_sec: z.number().int().default(30),
  max_search_results: z.number().int().default(5),
  user_agent: z.string().optional().nullable(),
});

export type WebToolsConfig = z.infer<typeof WebToolsConfigSchema>;

export const ImageGenerationToolConfigSchema = z.object({
  enabled: z.boolean().default(true),
  provider: z.string().default('auto'),
  model: z.string().optional().nullable(),
  size: z.string().default('1024x1024'),
  quality: z.string().default('standard'),
});

export type ImageGenerationToolConfig = z.infer<typeof ImageGenerationToolConfigSchema>;

export const MCPToolConfigSchema = z.object({
  enabled: z.boolean().default(true),
  servers: z.record(z.string(), z.unknown()).default({}),
});

export type MCPToolConfig = z.infer<typeof MCPToolConfigSchema>;

export const MyToolConfigSchema = z.object({
  enabled: z.boolean().default(true),
});

export type MyToolConfig = z.infer<typeof MyToolConfigSchema>;

export const CliAppsToolConfigSchema = z.object({
  enabled: z.boolean().default(true),
  apps: z.record(z.string(), z.unknown()).default({}),
});

export type CliAppsToolConfig = z.infer<typeof CliAppsToolConfigSchema>;

export const ToolsConfigSchema = z.object({
  filesystem: FileToolsConfigSchema.default({}),
  shell: ExecToolConfigSchema.default({}),
  web: WebToolsConfigSchema.default({}),
  image_generation: ImageGenerationToolConfigSchema.default({}),
  mcp: MCPToolConfigSchema.default({}),
  my: MyToolConfigSchema.default({}),
  cli_apps: CliAppsToolConfigSchema.default({}),
}).passthrough();

export type ToolsConfig = z.infer<typeof ToolsConfigSchema>;

export const MemoryConfigSchema = z.object({
  enabled: z.boolean().default(true),
  base_dir: z.string().default('memory'),
  dream: DreamConfigSchema.default({}),
});

export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;

export const CronConfigSchema = z.object({
  enabled: z.boolean().default(true),
  timezone: z.string().default('UTC'),
});

export type CronConfig = z.infer<typeof CronConfigSchema>;

export const GatewayConfigSchema = z.object({
  enabled: z.boolean().default(false),
  host: z.string().default('127.0.0.1'),
  port: z.number().int().default(8765),
  cors_origins: z.array(z.string()).default(['http://localhost:5173']),
  auth_token: z.string().optional().nullable(),
  webui_path: z.string().optional().nullable(),
});

export type GatewayConfig = z.infer<typeof GatewayConfigSchema>;

export const ApiConfigSchema = z.object({
  enabled: z.boolean().default(false),
  host: z.string().default('127.0.0.1'),
  port: z.number().int().default(8000),
  api_keys: z.array(z.string()).default([]),
  cors_origins: z.array(z.string()).default([]),
});

export type ApiConfig = z.infer<typeof ApiConfigSchema>;

export const SecurityConfigSchema = z.object({
  workspace_access: z.enum(['allow', 'deny', 'ask']).default('allow'),
  network_access: z.boolean().default(true),
  pth_guard: z.boolean().default(true),
});

export type SecurityConfig = z.infer<typeof SecurityConfigSchema>;

export const SessionsConfigSchema = z.object({
  storage: z.enum(['memory', 'file']).default('memory'),
  storage_path: z.string().default('sessions'),
});

export type SessionsConfig = z.infer<typeof SessionsConfigSchema>;

export const LoggingConfigSchema = z.object({
  level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  file_path: z.string().default('logs/kobot.log'),
  console_enabled: z.boolean().default(true),
});

export type LoggingConfig = z.infer<typeof LoggingConfigSchema>;

export const ProgressGuardConfigSchema = z.object({
  enabled: z.boolean().default(true),
  profile: z.enum(['coding', 'research', 'assistant', 'workflow']).default('assistant'),
  window_size: z.number().int().min(5).max(100).default(20),
  min_turns_before_detect: z.number().int().min(1).default(3),
  suspicious_threshold: z.number().min(0).max(1).default(0.4),
  stuck_threshold: z.number().min(0).max(1).default(0.7),
  failed_threshold: z.number().min(0).max(1).default(0.9),
  confirmation_turns: z.number().int().min(1).default(2),
  downgrade_turns: z.number().int().min(1).default(3),
  debug: z.boolean().default(false),
}).passthrough();

export type ProgressGuardConfig = z.infer<typeof ProgressGuardConfigSchema>;

export const ConfigSchema = z.object({
  schema_version: z.number().int().default(1),
  workspace: z.string().default('~/.kobot'),
  workspace_resolved: z.string().optional(),
  agents: AgentsConfigSchema,
  providers: ProvidersConfigSchema.default({ items: [], defaults: {} }),
  channels: ChannelsConfigSchema.default({}),
  tools: ToolsConfigSchema.default({}),
  memory: MemoryConfigSchema.default({}),
  transcription: TranscriptionConfigSchema.default({}),
  cron: CronConfigSchema.default({}),
  gateway: GatewayConfigSchema.default({}),
  api: ApiConfigSchema.default({}),
  security: SecurityConfigSchema.default({}),
  sessions: SessionsConfigSchema.default({}),
  logging: LoggingConfigSchema.default({}),
  progress_guard: ProgressGuardConfigSchema.default({}),
}).passthrough();

export type Config = z.infer<typeof ConfigSchema>;

export function defaultConfig(): Config {
  return ConfigSchema.parse({
    agents: {
      defaults: {},
      model_presets: {},
      instances: {},
    },
  });
}
