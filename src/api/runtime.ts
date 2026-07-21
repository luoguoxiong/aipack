import crypto from 'crypto';
import path from 'path';
import { logger } from '../utils/logger.js';

export interface ApiStartOptions {
  host?: string;
  port?: number;
  verbose?: boolean;
  workspace?: string;
  configPath?: string;
}

export interface ProcessRuntimePaths {
  runDir: string;
  logsDir: string;
  statePath: string;
  logPath: string;
}

export function apiRuntimePaths(configPath: string): ProcessRuntimePaths {
  const resolved = path.resolve(configPath);
  const suffix = crypto.createHash('sha256').update(resolved).digest('hex').slice(0, 16);
  const parentDir = path.dirname(resolved);
  const runDir = path.join(parentDir, 'run');
  const logsDir = path.join(parentDir, 'logs');
  return {
    runDir,
    logsDir,
    statePath: path.join(runDir, `api.${suffix}.json`),
    logPath: path.join(logsDir, `api.${suffix}.log`),
  };
}

export class ApiRuntime {
  serviceName = 'api';
  private pythonExecutable?: string;

  constructor(pythonExecutable?: string) {
    this.pythonExecutable = pythonExecutable;
  }

  private buildChildCommand(options: ApiStartOptions): string[] {
    const command = [
      this.pythonExecutable || process.execPath,
      '-m',
      'nanobot',
      'serve',
      '--host',
      options.host || '127.0.0.1',
      '--port',
      String(options.port || 8000),
    ];
    if (options.verbose) {
      command.push('--verbose');
    }
    if (options.workspace) {
      command.push('--workspace', options.workspace);
    }
    if (options.configPath) {
      command.push('--config', options.configPath);
    }
    return command;
  }
}
