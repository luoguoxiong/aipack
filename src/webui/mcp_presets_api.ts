import { logger } from '../utils/logger.js';

export interface McpPreset {
  name: string;
  description: string;
  servers: string[];
  enabled: boolean;
}

export class McpPresetsApi {
  private presets: Map<string, McpPreset> = new Map();

  constructor(presets: Record<string, unknown> = {}) {
    for (const [name, config] of Object.entries(presets)) {
      if (config && typeof config === 'object') {
        const c = config as Record<string, unknown>;
        this.presets.set(name, {
          name,
          description: typeof c.description === 'string' ? c.description : '',
          servers: Array.isArray(c.servers) ? c.servers.map(String) : [],
          enabled: c.enabled !== false,
        });
      }
    }
  }

  list(): McpPreset[] {
    return Array.from(this.presets.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): McpPreset | undefined {
    return this.presets.get(name);
  }

  payload(): { presets: McpPreset[] } {
    return {
      presets: this.list().filter((p) => p.enabled),
    };
  }
}
