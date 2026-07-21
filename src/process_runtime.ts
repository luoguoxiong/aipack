import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn, type ChildProcess, exec } from 'child_process';
import { EventEmitter } from 'events';

export interface ProcessStartOptions {
  port: number;
  verbose?: boolean;
  workspace?: string | null;
  config_path?: string | null;
}

export interface ProcessStatus {
  running: boolean;
  pid: number | null;
  state_path: string;
  log_path: string;
  started_at?: string | null;
  port?: number | null;
  command?: string[];
  reason: string;
}

export interface ProcessResult {
  ok: boolean;
  message: string;
  status: ProcessStatus;
}

export interface ProcessRuntimePaths {
  run_dir: string;
  logs_dir: string;
  state_path: string;
  log_path: string;
}

export function getPlatformName(): string {
  if (process.platform === 'win32') return 'Windows';
  if (process.platform === 'darwin') return 'Darwin';
  return 'Linux';
}

export function utcNow(): string {
  return new Date().toISOString();
}

function asInt(value: unknown): number | null {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = parseInt(value, 10);
    return isNaN(parsed) ? null : parsed;
  }
  return null;
}

function asStr(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

class LifecycleLock {
  private lockPath: string;

  constructor(statePath: string) {
    this.lockPath = statePath + '.lock';
  }

  async acquire(): Promise<void> {
    let attempts = 0;
    const maxAttempts = 10;
    while (attempts < maxAttempts) {
      try {
        const fd = fs.openSync(this.lockPath, 'wx');
        fs.closeSync(fd);
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
          attempts++;
          await new Promise((resolve) => setTimeout(resolve, 100));
        } else {
          throw err;
        }
      }
    }
    throw new Error('Failed to acquire lock');
  }

  async release(): Promise<void> {
    try {
      fs.unlinkSync(this.lockPath);
    } catch {
      // ignore
    }
  }
}

export class ManagedProcessRuntime extends EventEmitter {
  service_name = 'process';
  paths: ProcessRuntimePaths;
  platform_name: string;
  node_executable: string;

  constructor(paths: ProcessRuntimePaths, platformName?: string) {
    super();
    this.paths = paths;
    this.platform_name = platformName || getPlatformName();
    this.node_executable = process.execPath;
  }

  static refreshStatePid(paths: ProcessRuntimePaths): void {
    if (!fs.existsSync(paths.state_path)) return;
    try {
      const state = JSON.parse(fs.readFileSync(paths.state_path, 'utf-8'));
      state.pid = process.pid;
      state.started_at = utcNow();
      fs.writeFileSync(paths.state_path, JSON.stringify(state, null, 2) + '\n');
    } catch {
      // ignore
    }
  }

  async startBackground(options: ProcessStartOptions): Promise<ProcessResult> {
    const lock = new LifecycleLock(this.paths.state_path);
    await lock.acquire();
    try {
      return await this._startBackground(options);
    } finally {
      await lock.release();
    }
  }

  private async _startBackground(options: ProcessStartOptions): Promise<ProcessResult> {
    const current = this.status();
    if (current.running) {
      return { ok: false, message: this._message('already_running'), status: current };
    }

    const command = this._buildChildCommand(options);
    fs.mkdirSync(this.paths.run_dir, { recursive: true });
    fs.mkdirSync(this.paths.logs_dir, { recursive: true });

    const logHandle = fs.openSync(this.paths.log_path, 'a');

    const child = spawn(command[0], command.slice(1), {
      stdio: ['ignore', logHandle, logHandle],
      ...this._spawnPlatformOptions(),
    });

    const pid = child.pid;

    await new Promise((resolve) => setTimeout(resolve, 200));

    if (!this._isPidRunning(pid!)) {
      fs.closeSync(logHandle);
      return { ok: false, message: this._message('exited_during_startup'), status: this.status() };
    }

    this._writeState({
      pid,
      started_at: utcNow(),
      platform: this.platform_name,
      port: options.port,
      workspace: options.workspace,
      config_path: options.config_path,
      command,
      log_path: this.paths.log_path,
    });

    fs.closeSync(logHandle);

    return { ok: true, message: this._message('started_background'), status: this.status() };
  }

  async stop(timeout_s: number = 20): Promise<ProcessResult> {
    const lock = new LifecycleLock(this.paths.state_path);
    await lock.acquire();
    try {
      return await this._stop(timeout_s);
    } finally {
      await lock.release();
    }
  }

  private async _stop(timeout_s: number): Promise<ProcessResult> {
    const status = this.status();
    if (!status.pid) {
      return { ok: false, message: this._message('not_running'), status };
    }

    const state = this._readState();
    if (!state || !this._recordMatchesProcess(state, status.pid)) {
      this._clearState();
      return {
        ok: false,
        message: this._message('state_stale'),
        status: this.status('stale_state'),
      };
    }

    const terminated = await this._terminate(status.pid, timeout_s);
    const finalStatus = this.status(terminated ? 'stopped' : 'stop_timeout');

    if (!finalStatus.running) {
      this._clearState();
      return { ok: true, message: this._message('stopped'), status: finalStatus };
    }

    return { ok: false, message: this._message('stop_timeout'), status: finalStatus };
  }

  async restart(options: ProcessStartOptions, timeout_s: number = 20): Promise<ProcessResult> {
    const lock = new LifecycleLock(this.paths.state_path);
    await lock.acquire();
    try {
      const stopResult = await this._stop(timeout_s);
      const recoverable = new Set([this._message('not_running'), this._message('state_stale')]);
      if (!stopResult.ok && !recoverable.has(stopResult.message)) {
        return stopResult;
      }
      return await this._startBackground(options);
    } finally {
      await lock.release();
    }
  }

  status(reason?: string): ProcessStatus {
    const state = this._readState();
    const pid = state ? asInt(state.pid) : null;

    if (pid === null) {
      return {
        running: false,
        pid: null,
        state_path: this.paths.state_path,
        log_path: this.paths.log_path,
        reason: reason || 'not_started',
      };
    }

    if (!this._isPidRunning(pid) || (state && !this._recordMatchesProcess(state, pid))) {
      this._clearState();
      return {
        running: false,
        pid: null,
        state_path: this.paths.state_path,
        log_path: this.paths.log_path,
        reason: reason || 'stale_state',
      };
    }

    const command = state?.command;
    return {
      running: true,
      pid,
      state_path: this.paths.state_path,
      log_path: this.paths.log_path,
      started_at: asStr(state?.started_at),
      port: asInt(state?.port),
      command: Array.isArray(command) ? command : [],
      reason: reason || 'running',
    };
  }

  readLogTail(tail: number = 200): string[] {
    if (tail <= 0 || !fs.existsSync(this.paths.log_path)) return [];
    try {
      const content = fs.readFileSync(this.paths.log_path, 'utf-8');
      const lines = content.split('\n').filter((line) => line.trim());
      return lines.slice(-tail);
    } catch {
      return [];
    }
  }

  followLogs(tail: number = 200): Promise<number> {
    return new Promise((resolve) => {
      for (const line of this.readLogTail(tail)) {
        console.log(line);
      }

      fs.mkdirSync(this.paths.logs_dir, { recursive: true });
      if (!fs.existsSync(this.paths.log_path)) {
        fs.writeFileSync(this.paths.log_path, '');
      }

      const stream = fs.createReadStream(this.paths.log_path, { encoding: 'utf-8' });
      stream.on('data', (data) => {
        process.stdout.write(data);
      });

      process.on('SIGINT', () => {
        stream.close();
        resolve(130);
      });
    });
  }

  private _message(event: string): string {
    return `${this.service_name}_${event}`;
  }

  protected _buildChildCommand(options: ProcessStartOptions): string[] {
    throw new Error('Not implemented');
  }

  private _spawnPlatformOptions(): Record<string, unknown> {
    if (this.platform_name === 'Windows') {
      return {
        detached: true,
        windowsHide: true,
      };
    }
    return {
      detached: true,
    };
  }

  private async _terminate(pid: number, timeout_s: number): Promise<boolean> {
    if (this.platform_name === 'Windows') {
      return this._terminateWindows(pid, timeout_s);
    }
    return this._terminatePosix(pid, timeout_s);
  }

  private async _terminatePosix(pid: number, timeout_s: number): Promise<boolean> {
    try {
      process.kill(pid, 'SIGTERM');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
        return true;
      }
    }

    if (await this._waitForExit(pid, timeout_s)) {
      return true;
    }

    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // ignore
    }

    return await this._waitForExit(pid, 2);
  }

  private async _terminateWindows(pid: number, timeout_s: number): Promise<boolean> {
    return new Promise((resolve) => {
      exec(`taskkill /PID ${pid} /T`, (err) => {
        if (!err) {
          resolve(true);
          return;
        }

        exec(`taskkill /PID ${pid} /T /F`, () => {
          setTimeout(() => {
            resolve(!this._isPidRunning(pid));
          }, 2000);
        });
      });
    });
  }

  private async _waitForExit(pid: number, timeout_s: number): Promise<boolean> {
    const deadline = Date.now() + timeout_s * 1000;
    while (Date.now() < deadline) {
      if (!this._isPidRunning(pid)) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return !this._isPidRunning(pid);
  }

  private _isPidRunning(pid: number): boolean {
    if (pid <= 0) return false;

    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') return false;
      if (code === 'EPERM') return true;
      return false;
    }
  }

  private _recordMatchesProcess(state: Record<string, unknown>, pid: number): boolean {
    return true;
  }

  private _readState(): Record<string, unknown> | null {
    try {
      const content = fs.readFileSync(this.paths.state_path, 'utf-8');
      const payload = JSON.parse(content);
      return typeof payload === 'object' && payload !== null ? payload : null;
    } catch {
      return null;
    }
  }

  private _writeState(payload: Record<string, unknown>): void {
    fs.mkdirSync(this.paths.run_dir, { recursive: true });
    const tmpPath = this.paths.state_path + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2) + '\n');
    fs.renameSync(tmpPath, this.paths.state_path);
  }

  private _clearState(): void {
    try {
      fs.unlinkSync(this.paths.state_path);
    } catch {
      // ignore
    }
  }
}