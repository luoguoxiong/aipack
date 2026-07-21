import { logger } from '../utils/logger.js';

export interface CliApp {
  name: string;
  description: string;
  command: string;
  enabled: boolean;
  timeout_sec?: number;
}

export class CliAppsApi {
  private apps: Map<string, CliApp> = new Map();

  constructor(apps: Record<string, unknown> = {}) {
    for (const [name, config] of Object.entries(apps)) {
      if (config && typeof config === 'object') {
        const c = config as Record<string, unknown>;
        this.apps.set(name, {
          name,
          description: typeof c.description === 'string' ? c.description : '',
          command: typeof c.command === 'string' ? c.command : '',
          enabled: c.enabled !== false,
          timeout_sec: typeof c.timeout_sec === 'number' ? c.timeout_sec : undefined,
        });
      }
    }
  }

  list(): CliApp[] {
    return Array.from(this.apps.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): CliApp | undefined {
    return this.apps.get(name);
  }

  payload(): { apps: CliApp[] } {
    return {
      apps: this.list().filter((app) => app.enabled),
    };
  }
}
