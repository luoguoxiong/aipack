import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger.js';
import { getProjectConfigDir } from '../config/paths.js';

export interface WebuiSettings {
  schema_version: number;
  default_model: string | null;
  default_deployment: string | null;
  default_turn_editor_model: string | null;
  default_text_editor_model: string | null;
  theme: string | null;
  font_family: string | null;
  font_size: number | null;
  accept_bot_commands: boolean;
  accept_mcp_tools: boolean;
  developer_mode: boolean;
  show_developer_options: boolean;
  show_token_usage: boolean;
  enable_streaming: boolean;
  autosave_interval_sec: number | null;
  max_history_items: number | null;
  compact_mode: boolean;
  code_wrapping: boolean;
  enter_to_send: boolean;
  sync_model_preferences: boolean;
  disabled_builtin_skills: string[];
  default_session_instructions: string | null;
  default_model_params: Record<string, unknown> | null;
  pinned_plugins: string[];
  sidebar_collapsed: boolean;
  auto_transcribe_voice: boolean;
  prefer_cli_apps: boolean;
}

export const DEFAULT_SETTINGS: WebuiSettings = {
  schema_version: 1,
  default_model: null,
  default_deployment: null,
  default_turn_editor_model: null,
  default_text_editor_model: null,
  theme: null,
  font_family: null,
  font_size: null,
  accept_bot_commands: false,
  accept_mcp_tools: false,
  developer_mode: false,
  show_developer_options: false,
  show_token_usage: true,
  enable_streaming: true,
  autosave_interval_sec: null,
  max_history_items: null,
  compact_mode: false,
  code_wrapping: false,
  enter_to_send: true,
  sync_model_preferences: true,
  disabled_builtin_skills: [],
  default_session_instructions: null,
  default_model_params: null,
  pinned_plugins: [],
  sidebar_collapsed: false,
  auto_transcribe_voice: false,
  prefer_cli_apps: false,
};

const WEBUI_SETTINGS_PATH = path.join(getProjectConfigDir(), 'webui', 'settings.json');

function normalizeValue<T>(
  raw: unknown,
  defaultValue: T,
  type: 'string' | 'number' | 'boolean' | 'string_array',
): T {
  if (raw === undefined || raw === null) return defaultValue;
  switch (type) {
    case 'string':
      return typeof raw === 'string' ? (raw as T) : defaultValue;
    case 'number':
      return typeof raw === 'number' && !isNaN(raw) ? (raw as T) : defaultValue;
    case 'boolean':
      return typeof raw === 'boolean' ? (raw as T) : defaultValue;
    case 'string_array':
      if (!Array.isArray(raw)) return defaultValue;
      return raw.filter((v) => typeof v === 'string') as T;
    default:
      return defaultValue;
  }
}

function normalizeSettings(data: Record<string, unknown>): WebuiSettings {
  const s: WebuiSettings = { ...DEFAULT_SETTINGS };
  s.default_model = normalizeValue<string | null>(data.default_model, null, 'string');
  s.default_deployment = normalizeValue<string | null>(data.default_deployment, null, 'string');
  s.default_turn_editor_model = normalizeValue<string | null>(data.default_turn_editor_model, null, 'string');
  s.default_text_editor_model = normalizeValue<string | null>(data.default_text_editor_model, null, 'string');
  s.theme = normalizeValue<string | null>(data.theme, null, 'string');
  s.font_family = normalizeValue<string | null>(data.font_family, null, 'string');
  s.font_size = normalizeValue<number | null>(data.font_size, null, 'number');
  s.accept_bot_commands = normalizeValue(data.accept_bot_commands, false, 'boolean');
  s.accept_mcp_tools = normalizeValue(data.accept_mcp_tools, false, 'boolean');
  s.developer_mode = normalizeValue(data.developer_mode, false, 'boolean');
  s.show_developer_options = normalizeValue(data.show_developer_options, false, 'boolean');
  s.show_token_usage = normalizeValue(data.show_token_usage, true, 'boolean');
  s.enable_streaming = normalizeValue(data.enable_streaming, true, 'boolean');
  s.autosave_interval_sec = normalizeValue<number | null>(data.autosave_interval_sec, null, 'number');
  s.max_history_items = normalizeValue<number | null>(data.max_history_items, null, 'number');
  s.compact_mode = normalizeValue(data.compact_mode, false, 'boolean');
  s.code_wrapping = normalizeValue(data.code_wrapping, false, 'boolean');
  s.enter_to_send = normalizeValue(data.enter_to_send, true, 'boolean');
  s.sync_model_preferences = normalizeValue(data.sync_model_preferences, true, 'boolean');
  s.disabled_builtin_skills = normalizeValue<string[]>(data.disabled_builtin_skills, [], 'string_array');
  s.default_session_instructions = normalizeValue<string | null>(data.default_session_instructions, null, 'string');
  s.pinned_plugins = normalizeValue<string[]>(data.pinned_plugins, [], 'string_array');
  s.sidebar_collapsed = normalizeValue(data.sidebar_collapsed, false, 'boolean');
  s.auto_transcribe_voice = normalizeValue(data.auto_transcribe_voice, false, 'boolean');
  s.prefer_cli_apps = normalizeValue(data.prefer_cli_apps, false, 'boolean');
  if (data.default_model_params && typeof data.default_model_params === 'object') {
    s.default_model_params = { ...(data.default_model_params as Record<string, unknown>) };
  }
  return s;
}

export function readWebuiSettings(): WebuiSettings {
  try {
    if (!fs.existsSync(WEBUI_SETTINGS_PATH)) return { ...DEFAULT_SETTINGS };
    const content = fs.readFileSync(WEBUI_SETTINGS_PATH, 'utf-8');
    const data = JSON.parse(content);
    if (!data || typeof data !== 'object') return { ...DEFAULT_SETTINGS };
    return normalizeSettings(data as Record<string, unknown>);
  } catch (err) {
    logger.warn({ err }, 'Failed to read webui settings, using defaults');
    return { ...DEFAULT_SETTINGS };
  }
}

export function writeWebuiSettings(settings: WebuiSettings): void {
  try {
    const dir = path.dirname(WEBUI_SETTINGS_PATH);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = WEBUI_SETTINGS_PATH + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
    fs.renameSync(tmpPath, WEBUI_SETTINGS_PATH);
    logger.debug('Webui settings saved');
  } catch (err) {
    logger.error({ err }, 'Failed to write webui settings');
    throw err;
  }
}

export function updateWebuiSettings(
  updates: Partial<WebuiSettings>,
): WebuiSettings {
  const current = readWebuiSettings();
  const updated = normalizeSettings({
    ...(current as unknown as Record<string, unknown>),
    ...(updates as unknown as Record<string, unknown>),
  });
  writeWebuiSettings(updated);
  return updated;
}

export function webuiSettingsPayload(): WebuiSettings {
  return readWebuiSettings();
}
