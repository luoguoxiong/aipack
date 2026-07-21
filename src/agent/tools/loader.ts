import { BaseTool } from './base.js';
import { ToolRegistry } from './registry.js';
import { logger } from '../../utils/logger.js';
import { getFilesystemTools } from './filesystem.js';
import { getShellTools } from './shell.js';
import { getWebTools } from './web.js';
import { getMemoryTools } from './memory.js';
import { getCronTools } from './cron.js';
import { getUtilityTools } from './utilities.js';
import { getSearchTools } from './search.js';
import { getMessageTools } from './message.js';
import { getSelfTools } from './self.js';
import { getApplyPatchTools } from './apply_patch.js';
import { getLongTaskTools } from './long_task.js';
import { getSpawnTools } from './spawn.js';
import { getExecSessionTools } from './exec_session.js';

const _SKIP_MODULES = new Set([
  'base', 'schema', 'registry', 'context', 'loader', 'config',
  'file_state', 'sandbox', 'mcp', 'index', 'runtime_state', 'path_utils',
]);

export interface ToolLoaderOptions {
  scope?: string;
  filesystem?: boolean;
  shell?: boolean;
  web?: boolean;
  memory?: boolean;
  cron?: boolean;
  utilities?: boolean;
  search?: boolean;
  message?: boolean;
  self?: boolean;
  apply_patch?: boolean;
  long_task?: boolean;
  spawn?: boolean;
  exec_session?: boolean;
}

export class ToolLoader {
  private _discovered: BaseTool[] | null = null;

  constructor() {}

  discover(): BaseTool[] {
    if (this._discovered !== null) {
      return [...this._discovered];
    }

    const tools: BaseTool[] = [];
    const toolFactories: Array<() => BaseTool[]> = [
      getFilesystemTools,
      getShellTools,
      getWebTools,
      getMemoryTools,
      getCronTools,
      getUtilityTools,
      getSearchTools,
      getMessageTools,
      () => getSelfTools(),
      getApplyPatchTools,
      () => getLongTaskTools(),
      () => getSpawnTools(),
      getExecSessionTools,
    ];

    for (const factory of toolFactories) {
      try {
        const result = factory();
        for (const tool of result) {
          tools.push(tool);
        }
      } catch (e) {
        logger.error({ error: (e as Error).message }, 'Failed to load tool group');
      }
    }

    tools.sort((a, b) => a.name.localeCompare(b.name));
    this._discovered = tools;
    return [...tools];
  }

  load(registry: ToolRegistry, options?: ToolLoaderOptions): string[] {
    const registered: string[] = [];
    const scope = options?.scope ?? 'core';
    const opts = {
      filesystem: true,
      shell: true,
      web: true,
      memory: true,
      cron: true,
      utilities: true,
      search: true,
      message: true,
      self: true,
      apply_patch: true,
      long_task: true,
      spawn: false,
      exec_session: false,
      ...options,
    };

    const toolGroups: Array<[string, () => BaseTool[]]> = [];

    if (opts.filesystem) toolGroups.push(['filesystem', getFilesystemTools]);
    if (opts.shell) toolGroups.push(['shell', getShellTools]);
    if (opts.web) toolGroups.push(['web', getWebTools]);
    if (opts.memory) toolGroups.push(['memory', getMemoryTools]);
    if (opts.cron) toolGroups.push(['cron', getCronTools]);
    if (opts.utilities) toolGroups.push(['utilities', getUtilityTools]);
    if (opts.search) toolGroups.push(['search', getSearchTools]);
    if (opts.message) toolGroups.push(['message', getMessageTools]);
    if (opts.self) toolGroups.push(['self', () => getSelfTools()]);
    if (opts.apply_patch) toolGroups.push(['apply_patch', getApplyPatchTools]);
    if (opts.long_task) toolGroups.push(['long_task', () => getLongTaskTools()]);
    if (opts.spawn) toolGroups.push(['spawn', () => getSpawnTools()]);
    if (opts.exec_session) toolGroups.push(['exec_session', getExecSessionTools]);

    for (const [groupName, factory] of toolGroups) {
      try {
        const tools = factory();
        for (const tool of tools) {
          if (tool.scope && scope !== 'global' && tool.scope !== scope) {
            continue;
          }
          if (registry.has(tool.name)) {
            logger.warn(
              { tool: tool.name, group: groupName },
              'Tool name collision: overwriting existing tool',
            );
          }
          registry.register(tool);
          registered.push(tool.name);
          logger.debug({ tool: tool.name, group: groupName }, 'Loaded tool');
        }
      } catch (e) {
        logger.error(
          { group: groupName, error: (e as Error).message },
          'Failed to load tool group',
        );
      }
    }

    return registered;
  }
}

export function createToolLoader(): ToolLoader {
  return new ToolLoader();
}
