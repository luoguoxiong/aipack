import fs from 'fs/promises';
import path from 'path';
import { logger } from '../utils/logger.js';
import { getProjectConfigDir } from '../config/paths.js';

export interface MCPPreset {
  id: string;
  name: string;
  description: string;
  server_url: string;
  server_token?: string;
  enabled: boolean;
  tools?: string[];
  icon?: string;
  provider_name?: string;
  source?: string;
}

const _presets: Map<string, MCPPreset> = new Map();
const _PRESETS_PATH = path.join(getProjectConfigDir(), 'mcp', 'presets.json');

export async function loadMCPPresets(): Promise<void> {
  _presets.clear();
  try {
    const data = await fs.readFile(_PRESETS_PATH, 'utf-8');
    const presets = JSON.parse(data) as MCPPreset[];
    for (const preset of presets) {
      _presets.set(preset.id, preset);
    }
  } catch {
    // File not found or corrupted
  }
}

export async function saveMCPPresets(): Promise<void> {
  try {
    const dir = path.dirname(_PRESETS_PATH);
    await fs.mkdir(dir, { recursive: true });
    const presets = Array.from(_presets.values());
    await fs.writeFile(_PRESETS_PATH, JSON.stringify(presets, null, 2));
  } catch (err) {
    logger.error({ err }, 'Failed to save MCP presets');
  }
}

export function listMCPPresets(): MCPPreset[] {
  return Array.from(_presets.values());
}

export function getMCPPreset(id: string): MCPPreset | undefined {
  return _presets.get(id);
}

export function addMCPPreset(preset: MCPPreset): void {
  _presets.set(preset.id, preset);
  saveMCPPresets();
}

export function updateMCPPreset(id: string, updates: Partial<MCPPreset>): boolean {
  const preset = _presets.get(id);
  if (!preset) return false;
  _presets.set(id, { ...preset, ...updates });
  saveMCPPresets();
  return true;
}

export function deleteMCPPreset(id: string): boolean {
  const deleted = _presets.delete(id);
  if (deleted) {
    saveMCPPresets();
  }
  return deleted;
}

export function enableMCPPreset(id: string): boolean {
  return updateMCPPreset(id, { enabled: true });
}

export function disableMCPPreset(id: string): boolean {
  return updateMCPPreset(id, { enabled: false });
}

export function getEnabledMCPPresets(): MCPPreset[] {
  return Array.from(_presets.values()).filter(p => p.enabled);
}