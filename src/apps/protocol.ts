export interface AppManifest {
  id: string;
  name: string;
  description: string;
  version: string;
  author?: string;
  repository?: string;
  license?: string;
  dependencies?: Record<string, string>;
  commands?: AppCommand[];
  hooks?: AppHook[];
  config?: AppConfigSchema;
}

export interface AppCommand {
  name: string;
  description: string;
  usage?: string;
  arguments?: AppArgument[];
  options?: AppOption[];
}

export interface AppArgument {
  name: string;
  description: string;
  required?: boolean;
  type?: 'string' | 'number' | 'boolean';
}

export interface AppOption {
  name: string;
  short?: string;
  description: string;
  type?: 'string' | 'number' | 'boolean';
  default?: unknown;
}

export interface AppHook {
  event: string;
  handler: string;
}

export interface AppConfigSchema {
  properties?: Record<string, ConfigProperty>;
  required?: string[];
}

export interface ConfigProperty {
  type: string;
  description: string;
  default?: unknown;
  enum?: unknown[];
}

export interface AppInstallState {
  manifest: AppManifest;
  installedAt: string;
  installPath: string;
  enabled: boolean;
  config?: Record<string, unknown>;
}

export interface AppInstallPlan {
  manifest: AppManifest;
  installPath: string;
  dependencies: string[];
  requiresRestart: boolean;
}

export interface AppUninstallPlan {
  installPath: string;
  removes: string[];
  requiresRestart: boolean;
}

export const APP_MANIFEST_FILENAME = 'nanobot-app.json';
export const APP_INSTALL_DIR = 'apps';
export const APP_CONFIG_DIR = 'config';

export function parseAppManifest(content: string): AppManifest {
  return JSON.parse(content);
}

export function validateAppManifest(manifest: AppManifest): string[] {
  const errors: string[] = [];
  if (!manifest.id) errors.push('Missing app id');
  if (!manifest.name) errors.push('Missing app name');
  if (!manifest.version) errors.push('Missing app version');
  return errors;
}

export function buildInstallPlan(manifest: AppManifest, installPath: string): AppInstallPlan {
  return {
    manifest,
    installPath,
    dependencies: Object.keys(manifest.dependencies || {}),
    requiresRestart: (manifest.hooks?.length || 0) > 0,
  };
}

export function buildUninstallPlan(installState: AppInstallState): AppUninstallPlan {
  return {
    installPath: installState.installPath,
    removes: [],
    requiresRestart: (installState.manifest.hooks?.length || 0) > 0,
  };
}