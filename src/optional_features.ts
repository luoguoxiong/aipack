import fs from 'fs/promises';
import path from 'path';
import { logger } from './utils/logger.js';
import { getProjectConfigDir } from './config/paths.js';

export interface OptionalFeature {
  name: string;
  label: string;
  description: string;
  enabled: boolean;
  installed: boolean;
  requiresRestart: boolean;
  providerName?: string;
  installState?: string;
  packageName?: string;
}

const _features: Map<string, OptionalFeature> = new Map();
const _FEATURES_PATH = path.join(getProjectConfigDir(), 'features.json');

const _BUILTIN_FEATURES: OptionalFeature[] = [
  {
    name: 'mcp_tools',
    label: 'MCP Tools',
    description: 'Enable Model Context Protocol tools for extended capabilities',
    enabled: false,
    installed: false,
    requiresRestart: true,
    installState: 'available',
  },
  {
    name: 'image_generation',
    label: 'Image Generation',
    description: 'Enable AI image generation capabilities',
    enabled: false,
    installed: false,
    requiresRestart: true,
    installState: 'available',
  },
  {
    name: 'transcription',
    label: 'Audio Transcription',
    description: 'Enable audio-to-text transcription',
    enabled: false,
    installed: false,
    requiresRestart: true,
    installState: 'available',
  },
];

export async function loadOptionalFeatures(): Promise<void> {
  _features.clear();
  for (const feature of _BUILTIN_FEATURES) {
    _features.set(feature.name, { ...feature });
  }
  try {
    const data = await fs.readFile(_FEATURES_PATH, 'utf-8');
    const saved = JSON.parse(data) as Record<string, Partial<OptionalFeature>>;
    for (const [name, updates] of Object.entries(saved)) {
      const feature = _features.get(name);
      if (feature) {
        _features.set(name, { ...feature, ...updates });
      }
    }
  } catch {
    // File not found or corrupted
  }
}

export async function saveOptionalFeatures(): Promise<void> {
  try {
    const dir = path.dirname(_FEATURES_PATH);
    await fs.mkdir(dir, { recursive: true });
    const saved: Record<string, Partial<OptionalFeature>> = {};
    for (const [name, feature] of _features) {
      saved[name] = {
        enabled: feature.enabled,
        installed: feature.installed,
        installState: feature.installState,
      };
    }
    await fs.writeFile(_FEATURES_PATH, JSON.stringify(saved, null, 2));
  } catch (err) {
    logger.error({ err }, 'Failed to save optional features');
  }
}

export function listOptionalFeatures(): OptionalFeature[] {
  return Array.from(_features.values());
}

export function getOptionalFeature(name: string): OptionalFeature | undefined {
  return _features.get(name);
}

export async function enableOptionalFeature(name: string): Promise<OptionalFeature | null> {
  const feature = _features.get(name);
  if (!feature) return null;
  
  if (!feature.installed) {
    await installOptionalFeature(name);
  }
  
  feature.enabled = true;
  await saveOptionalFeatures();
  logger.info({ feature: name }, 'Optional feature enabled');
  return feature;
}

export function disableOptionalFeature(name: string): OptionalFeature | null {
  const feature = _features.get(name);
  if (!feature) return null;
  
  feature.enabled = false;
  saveOptionalFeatures();
  logger.info({ feature: name }, 'Optional feature disabled');
  return feature;
}

export async function installOptionalFeature(name: string): Promise<boolean> {
  const feature = _features.get(name);
  if (!feature) return false;
  
  try {
    feature.installState = 'installing';
    await saveOptionalFeatures();
    
    feature.installed = true;
    feature.installState = 'installed';
    await saveOptionalFeatures();
    logger.info({ feature: name }, 'Optional feature installed');
    return true;
  } catch (err) {
    logger.error({ err, feature: name }, 'Failed to install optional feature');
    feature.installState = 'error';
    await saveOptionalFeatures();
    return false;
  }
}

export async function uninstallOptionalFeature(name: string): Promise<boolean> {
  const feature = _features.get(name);
  if (!feature) return false;
  
  try {
    feature.installState = 'uninstalling';
    await saveOptionalFeatures();
    
    feature.installed = false;
    feature.enabled = false;
    feature.installState = 'available';
    await saveOptionalFeatures();
    logger.info({ feature: name }, 'Optional feature uninstalled');
    return true;
  } catch (err) {
    logger.error({ err, feature: name }, 'Failed to uninstall optional feature');
    feature.installState = 'error';
    await saveOptionalFeatures();
    return false;
  }
}