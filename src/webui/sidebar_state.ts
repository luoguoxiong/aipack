import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger.js';
import { getProjectConfigDir } from '../config/paths.js';

export const WEBUI_SIDEBAR_STATE_SCHEMA_VERSION = 1;
const MAX_STATE_FILE_BYTES = 256 * 1024;
const MAX_LIST_ITEMS = 2000;
const MAX_MAP_ITEMS = 2000;
const MAX_KEY_LEN = 512;
const MAX_TITLE_LEN = 160;
const MAX_TAG_LEN = 40;
const ALLOWED_DENSITIES = new Set(['comfortable', 'compact']);
const ALLOWED_SORTS = new Set(['updated_desc', 'created_desc', 'title_asc']);

export interface SidebarViewState {
  density: string;
  show_previews: boolean;
  show_timestamps: boolean;
  show_archived: boolean;
  sort: string;
}

export interface SidebarState {
  schema_version: number;
  pinned_keys: string[];
  archived_keys: string[];
  title_overrides: Record<string, string>;
  project_name_overrides: Record<string, string>;
  tags_by_key: Record<string, string[]>;
  collapsed_groups: Record<string, boolean>;
  view: SidebarViewState;
  updated_at: string | null;
}

function getWebuiDir(): string {
  return path.join(getProjectConfigDir(), 'webui');
}

export function webuiSidebarStatePath(): string {
  return path.join(getWebuiDir(), 'sidebar-state.json');
}

export function defaultWebuiSidebarState(): SidebarState {
  return {
    schema_version: WEBUI_SIDEBAR_STATE_SCHEMA_VERSION,
    pinned_keys: [],
    archived_keys: [],
    title_overrides: {},
    project_name_overrides: {},
    tags_by_key: {},
    collapsed_groups: {},
    view: {
      density: 'comfortable',
      show_previews: false,
      show_timestamps: false,
      show_archived: false,
      sort: 'updated_desc',
    },
    updated_at: null,
  };
}

function cleanString(value: unknown, maxLen = MAX_KEY_LEN): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim();
  if (!cleaned) return null;
  return cleaned.slice(0, maxLen);
}

function cleanStringList(value: unknown, maxLen = MAX_KEY_LEN): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value.slice(0, MAX_LIST_ITEMS)) {
    const cleaned = cleanString(item, maxLen);
    if (cleaned === null || seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
  }
  return out;
}

function cleanBoolMap(value: unknown): Record<string, boolean> {
  if (typeof value !== 'object' || value === null) return {};
  const out: Record<string, boolean> = {};
  const entries = Object.entries(value as Record<string, unknown>).slice(0, MAX_MAP_ITEMS);
  for (const [key, raw] of entries) {
    const cleanedKey = cleanString(key);
    if (cleanedKey === null) continue;
    out[cleanedKey] = Boolean(raw);
  }
  return out;
}

function cleanTitleOverrides(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null) return {};
  const out: Record<string, string> = {};
  const entries = Object.entries(value as Record<string, unknown>).slice(0, MAX_MAP_ITEMS);
  for (const [key, rawTitle] of entries) {
    const cleanedKey = cleanString(key);
    const cleanedTitle = cleanString(rawTitle, MAX_TITLE_LEN);
    if (cleanedKey === null || cleanedTitle === null) continue;
    out[cleanedKey] = cleanedTitle;
  }
  return out;
}

function cleanTagsByKey(value: unknown): Record<string, string[]> {
  if (typeof value !== 'object' || value === null) return {};
  const out: Record<string, string[]> = {};
  const entries = Object.entries(value as Record<string, unknown>).slice(0, MAX_MAP_ITEMS);
  for (const [key, rawTags] of entries) {
    const cleanedKey = cleanString(key);
    if (cleanedKey === null) continue;
    const tags = cleanStringList(rawTags, MAX_TAG_LEN).slice(0, 12);
    if (tags.length > 0) {
      out[cleanedKey] = tags;
    }
  }
  return out;
}

function cleanView(value: unknown): SidebarViewState {
  const defaultView = defaultWebuiSidebarState().view;
  if (typeof value !== 'object' || value === null) {
    return { ...defaultView };
  }
  const v = value as Record<string, unknown>;
  const density = typeof v.density === 'string' && ALLOWED_DENSITIES.has(v.density)
    ? v.density
    : defaultView.density;
  const sort = typeof v.sort === 'string' && ALLOWED_SORTS.has(v.sort)
    ? v.sort
    : defaultView.sort;
  return {
    density,
    show_previews: Boolean(v.show_previews ?? defaultView.show_previews),
    show_timestamps: Boolean(v.show_timestamps ?? defaultView.show_timestamps),
    show_archived: Boolean(v.show_archived ?? defaultView.show_archived),
    sort,
  };
}

export function normalizeWebuiSidebarState(raw: unknown): SidebarState {
  if (typeof raw !== 'object' || raw === null) {
    raw = {};
  }
  const state = defaultWebuiSidebarState();
  const r = raw as Record<string, unknown>;
  state.pinned_keys = cleanStringList(r.pinned_keys);
  state.archived_keys = cleanStringList(r.archived_keys);
  state.title_overrides = cleanTitleOverrides(r.title_overrides);
  state.project_name_overrides = cleanTitleOverrides(r.project_name_overrides);
  state.tags_by_key = cleanTagsByKey(r.tags_by_key);
  state.collapsed_groups = cleanBoolMap(r.collapsed_groups);
  state.view = cleanView(r.view);
  const updatedAt = r.updated_at;
  state.updated_at = typeof updatedAt === 'string' ? updatedAt : null;
  return state;
}

export function readWebuiSidebarState(): SidebarState {
  const filePath = webuiSidebarStatePath();
  if (!fs.existsSync(filePath)) {
    return defaultWebuiSidebarState();
  }
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_STATE_FILE_BYTES) {
      logger.warn({ path: filePath }, 'webui sidebar state too large, ignoring');
      return defaultWebuiSidebarState();
    }
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return normalizeWebuiSidebarState(raw);
  } catch (err) {
    logger.warn({ err, path: filePath }, 'read webui sidebar state failed');
    return defaultWebuiSidebarState();
  }
}

export function writeWebuiSidebarState(raw: Partial<SidebarState>): SidebarState {
  const state = normalizeWebuiSidebarState(raw);
  state.updated_at = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const encoded = Buffer.from(JSON.stringify(state, null, 2) + '\n', 'utf-8');
  if (encoded.length > MAX_STATE_FILE_BYTES) {
    throw new Error('sidebar state is too large');
  }

  const filePath = webuiSidebarStatePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, encoded);
  fs.renameSync(tmpPath, filePath);
  return state;
}
