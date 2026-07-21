import { BaseTool, ToolContext, ToolResult, createToolResult, createToolError } from './base.js';
import { z } from 'zod';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import { logger } from '../../utils/logger.js';

const CliAppsSchema = z.object({
  name: z.string().describe(
    'Installed CLI app registry name, for example gimp, safari, or obsidian.',
  ),
  args: z.array(z.string()).optional().describe(
    'Arguments to pass to the CLI entry point. Do not include the entry point itself.',
  ),
  json: z.boolean().optional().describe(
    'Whether to prepend --json when supported by the CLI.',
  ),
  working_dir: z.string().optional().describe(
    'Optional working directory for the CLI call.',
  ),
  timeout: z.number().int().min(1).max(600).optional().describe(
    'Timeout in seconds for this CLI call.',
  ),
});

export interface CliAppDefinition {
  name: string;
  display_name?: string;
  command: string;
  args?: string[];
  description?: string;
  version?: string;
  icon?: string;
  supports_json?: boolean;
}

export interface CliAppsConfig {
  enable: boolean;
  install_timeout: number;
  run_timeout: number;
  catalog_ttl_seconds: number;
}

export class CliAppError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliAppError';
  }
}

export class CliAppManager {
  private workspace: string;
  private runtime: {
    install_timeout: number;
    run_timeout: number;
    catalog_ttl_seconds: number;
  };
  private apps: Map<string, CliAppDefinition> = new Map();

  constructor(
    workspace: string,
    runtime?: Partial<{
      install_timeout: number;
      run_timeout: number;
      catalog_ttl_seconds: number;
    }>,
  ) {
    this.workspace = workspace;
    this.runtime = {
      install_timeout: 300,
      run_timeout: 60,
      catalog_ttl_seconds: 3600,
      ...runtime,
    };
  }

  registerApp(app: CliAppDefinition): void {
    this.apps.set(app.name, app);
    logger.debug({ app: app.name }, 'Registered CLI app');
  }

  unregisterApp(name: string): boolean {
    return this.apps.delete(name);
  }

  installedNames(): string[] {
    return Array.from(this.apps.keys()).sort();
  }

  getApp(name: string): CliAppDefinition | undefined {
    return this.apps.get(name);
  }

  listApps(): CliAppDefinition[] {
    return Array.from(this.apps.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  async run(params: {
    name: string;
    args?: string[];
    json_output?: boolean;
    working_dir?: string;
    timeout?: number;
    restrict_to_workspace?: boolean;
  }): Promise<string> {
    const { name, args = [], json_output = false, working_dir, timeout, restrict_to_workspace } = params;

    const app = this.apps.get(name);
    if (!app) {
      throw new CliAppError(`Unknown CLI app: ${name}. Available: ${this.installedNames().join(', ') || '(none)'}`);
    }

    let cwd = working_dir
      ? path.isAbsolute(working_dir)
        ? working_dir
        : path.resolve(this.workspace, working_dir)
      : this.workspace;

    if (restrict_to_workspace) {
      const resolvedWs = path.resolve(this.workspace);
      const resolvedCwd = path.resolve(cwd);
      if (!resolvedCwd.startsWith(resolvedWs)) {
        throw new CliAppError('Working directory must be within workspace');
      }
    }

    const cmdArgs: string[] = [...(app.args || [])];
    if (json_output && app.supports_json) {
      cmdArgs.unshift('--json');
    }
    cmdArgs.push(...args);

    const timeoutMs = (timeout || this.runtime.run_timeout) * 1000;

    return await this._runCommand(app.command, cmdArgs, cwd, timeoutMs);
  }

  private async _runCommand(
    command: string,
    args: string[],
    cwd: string,
    timeoutMs: number,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const proc = spawn(command, args, {
        cwd,
        env: process.env,
      });

      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGTERM');
        setTimeout(() => {
          if (!proc.killed) proc.kill('SIGKILL');
        }, 5000);
      }, timeoutMs);

      proc.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(new CliAppError(`Failed to run CLI app: ${err.message}`));
      });

      proc.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) {
          reject(new CliAppError(`CLI app timed out after ${timeoutMs / 1000}s`));
          return;
        }
        const output = stdout + (stderr ? `\n[stderr]\n${stderr}` : '');
        if (code !== 0) {
          reject(new CliAppError(`CLI app exited with code ${code}:\n${output}`));
          return;
        }
        resolve(output || '(no output)');
      });
    });
  }
}

export class CliAppsTool extends BaseTool {
  name = 'run_cli_app';
  input_schema = CliAppsSchema;
  tags = ['cli', 'apps'];

  private manager: CliAppManager;
  private workspace: string;
  private restrictToWorkspace: boolean;

  constructor(
    workspace: string,
    options?: {
      restrict_to_workspace?: boolean;
      runtime?: Partial<{
        install_timeout: number;
        run_timeout: number;
        catalog_ttl_seconds: number;
      }>;
      manager?: CliAppManager;
    },
  ) {
    super();
    this.workspace = workspace;
    this.restrictToWorkspace = options?.restrict_to_workspace ?? false;
    this.manager = options?.manager || new CliAppManager(workspace, options?.runtime);
  }

  getManager(): CliAppManager {
    return this.manager;
  }

  get description(): string {
    let installed: string[] = [];
    try {
      installed = this.manager.installedNames();
    } catch {
      // ignore
    }
    const base = (
      'Run a CLI App that the user explicitly installed in Settings or attached as @app. ' +
      'Do not use this for ordinary system CLIs such as git, gh, python, npm, or brew; ' +
      'unknown names are rejected. Execution uses argv, not shell.'
    );
    if (installed.length > 0) {
      return base + ` Installed Settings CLI Apps: ${installed.join(', ')}.`;
    }
    return base + ' No Settings CLI Apps are currently installed.';
  }

  async execute(args: unknown, context: ToolContext): Promise<ToolResult> {
    try {
      const params = this.input_schema.parse(args);
      const ws = context.workspace || this.workspace;
      const result = await this.manager.run({
        name: params.name,
        args: params.args,
        json_output: params.json,
        working_dir: params.working_dir,
        timeout: params.timeout,
        restrict_to_workspace: this.restrictToWorkspace,
      });
      return createToolResult(result);
    } catch (err) {
      if (err instanceof CliAppError) {
        return createToolError(`Error: ${err.message}`);
      }
      return createToolError(`Error: ${(err as Error).message}`);
    }
  }
}

export function getCliAppsTools(
  workspace: string,
  options?: {
    restrict_to_workspace?: boolean;
    runtime?: Partial<{
      install_timeout: number;
      run_timeout: number;
      catalog_ttl_seconds: number;
    }>;
  },
): BaseTool[] {
  return [new CliAppsTool(workspace, options)];
}
