import fs from 'fs';
import path from 'path';
import { logger } from '../../utils/logger.js';
import {
  AppManifest,
  AppInstallState,
  AppInstallPlan,
  AppUninstallPlan,
  APP_MANIFEST_FILENAME,
  validateAppManifest,
  buildInstallPlan,
  buildUninstallPlan,
} from '../protocol.js';

export class CliAppService {
  private _catalogPath: string;
  private _installDir: string;
  private _installStates: Map<string, AppInstallState> = new Map();

  constructor(catalogPath: string, installDir: string) {
    this._catalogPath = catalogPath;
    this._installDir = installDir;
    this._loadInstallStates();
  }

  private _loadInstallStates(): void {
    try {
      if (!fs.existsSync(this._installDir)) {
        fs.mkdirSync(this._installDir, { recursive: true });
        return;
      }

      const entries = fs.readdirSync(this._installDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const manifestPath = path.join(this._installDir, entry.name, APP_MANIFEST_FILENAME);
        if (!fs.existsSync(manifestPath)) continue;

        try {
          const content = fs.readFileSync(manifestPath, 'utf-8');
          const manifest = JSON.parse(content) as AppManifest;
          const state: AppInstallState = {
            manifest,
            installedAt: fs.statSync(manifestPath).birthtime.toISOString(),
            installPath: path.join(this._installDir, entry.name),
            enabled: true,
          };
          this._installStates.set(manifest.id, state);
        } catch (err) {
          logger.error(`Failed to load app ${entry.name}: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      logger.error(`Failed to load app catalog: ${(err as Error).message}`);
    }
  }

  listInstalled(): AppInstallState[] {
    return Array.from(this._installStates.values());
  }

  getInstallState(appId: string): AppInstallState | undefined {
    return this._installStates.get(appId);
  }

  async install(manifest: AppManifest): Promise<AppInstallState | null> {
    const errors = validateAppManifest(manifest);
    if (errors.length > 0) {
      logger.error(`Invalid app manifest: ${errors.join(', ')}`);
      return null;
    }

    if (this._installStates.has(manifest.id)) {
      logger.error(`App ${manifest.id} is already installed`);
      return null;
    }

    const installPath = path.join(this._installDir, manifest.id);
    const plan = buildInstallPlan(manifest, installPath);

    try {
      fs.mkdirSync(installPath, { recursive: true });
      const manifestPath = path.join(installPath, APP_MANIFEST_FILENAME);
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

      const state: AppInstallState = {
        manifest,
        installedAt: new Date().toISOString(),
        installPath,
        enabled: true,
      };
      this._installStates.set(manifest.id, state);

      logger.info(`App ${manifest.id} installed successfully`);
      return state;
    } catch (err) {
      logger.error(`Failed to install app ${manifest.id}: ${(err as Error).message}`);
      try {
        fs.rmSync(installPath, { recursive: true });
      } catch {
        // ignore
      }
      return null;
    }
  }

  async uninstall(appId: string): Promise<boolean> {
    const state = this._installStates.get(appId);
    if (!state) {
      logger.error(`App ${appId} is not installed`);
      return false;
    }

    const plan = buildUninstallPlan(state);

    try {
      fs.rmSync(state.installPath, { recursive: true });
      this._installStates.delete(appId);

      logger.info(`App ${appId} uninstalled successfully`);
      return true;
    } catch (err) {
      logger.error(`Failed to uninstall app ${appId}: ${(err as Error).message}`);
      return false;
    }
  }

  async enable(appId: string): Promise<boolean> {
    const state = this._installStates.get(appId);
    if (!state) {
      logger.error(`App ${appId} is not installed`);
      return false;
    }

    if (state.enabled) {
      logger.warn(`App ${appId} is already enabled`);
      return true;
    }

    state.enabled = true;
    logger.info(`App ${appId} enabled`);
    return true;
  }

  async disable(appId: string): Promise<boolean> {
    const state = this._installStates.get(appId);
    if (!state) {
      logger.error(`App ${appId} is not installed`);
      return false;
    }

    if (!state.enabled) {
      logger.warn(`App ${appId} is already disabled`);
      return true;
    }

    state.enabled = false;
    logger.info(`App ${appId} disabled`);
    return true;
  }

  async run(appId: string, args: string[]): Promise<{ success: boolean; output?: string; error?: string }> {
    const state = this._installStates.get(appId);
    if (!state) {
      return { success: false, error: `App ${appId} is not installed` };
    }

    if (!state.enabled) {
      return { success: false, error: `App ${appId} is disabled` };
    }

    try {
      const appDir = state.installPath;
      const entryScript = path.join(appDir, 'index.js');

      if (!fs.existsSync(entryScript)) {
        return { success: false, error: `App entry script not found: ${entryScript}` };
      }

      logger.info(`Running app ${appId} with args: ${args.join(' ')}`);
      return { success: true, output: '' };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }
}