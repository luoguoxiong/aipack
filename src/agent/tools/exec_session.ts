import { BaseTool, ToolContext, ToolResult, createToolResult, createToolError } from './base.js';
import { z } from 'zod';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import path from 'path';
import crypto from 'crypto';
import { currentRequestSessionKey } from './context.js';
import { logger } from '../../utils/logger.js';

const DEFAULT_YIELD_MS = 1000;
const MAX_YIELD_MS = 30000;
const DEFAULT_WAIT_FOR_MS = 10000;
const MAX_WAIT_FOR_MS = 120000;
const DEFAULT_MAX_OUTPUT_CHARS = 10000;
const MAX_OUTPUT_CHARS = 50000;
const OUTPUT_DRAIN_GRACE_S = 100;

interface SessionPoll {
  output: string;
  done: boolean;
  exit_code: number | null;
  elapsed_s: number;
  timed_out: boolean;
  terminated: boolean;
  stdin_closed: boolean;
  truncated_chars: number;
}

export interface ExecSessionInfo {
  session_id: string;
  command: string;
  cwd: string;
  elapsed_s: number;
  idle_s: number;
  remaining_s: number;
  returncode: number | null;
  owner_session_key: string | null;
}

class ExecSession {
  session_id: string;
  process: ChildProcessWithoutNullStreams;
  command: string;
  cwd: string;
  owner_session_key: string | null;
  started_at: number;
  deadline: number;
  last_access: number;
  private _chunks: string[] = [];
  private _lock: Promise<void> = Promise.resolve();
  private _timed_out = false;
  private _stdout_done = false;
  private _stderr_done = false;

  constructor(options: {
    session_id: string;
    process: ChildProcessWithoutNullStreams;
    command: string;
    cwd: string;
    timeout: number | null;
    owner_session_key: string | null;
  }) {
    this.session_id = options.session_id;
    this.process = options.process;
    this.command = options.command;
    this.cwd = options.cwd;
    this.owner_session_key = options.owner_session_key;
    this.started_at = Date.now() / 1000;
    this.deadline = options.timeout ? Date.now() / 1000 + options.timeout : Infinity;
    this.last_access = Date.now() / 1000;

    this._readStream(this.process.stdout, '');
    this._readStream(this.process.stderr, 'STDERR:\n');
  }

  private async _withLock<T>(fn: () => Promise<T> | T): Promise<T> {
    const result = this._lock.then(() => fn());
    this._lock = result.then(() => undefined).catch(() => undefined);
    return result;
  }

  private _readStream(stream: NodeJS.ReadableStream, prefix: string): void {
    let first = true;
    stream.on('data', (chunk: Buffer) => {
      let text = chunk.toString('utf-8');
      if (prefix && first) {
        text = prefix + text;
        first = false;
      }
      this._withLock(() => {
        this._chunks.push(text);
      });
    });
    stream.on('end', () => {
      if (stream === this.process.stdout) this._stdout_done = true;
      if (stream === this.process.stderr) this._stderr_done = true;
    });
  }

  async write(chars: string): Promise<string | null> {
    if (this.process.exitCode !== null) {
      return 'session has already exited';
    }
    try {
      const canWrite = this.process.stdin.write(chars, 'utf-8');
      if (!canWrite) {
        await new Promise<void>((resolve) => {
          this.process.stdin.once('drain', resolve);
        });
      }
      return null;
    } catch (e) {
      return 'session stdin is closed';
    }
  }

  async closeStdin(): Promise<string | null> {
    if (this.process.exitCode !== null) {
      return 'session has already exited';
    }
    try {
      this.process.stdin.end();
      return null;
    } catch (e) {
      return 'session stdin is not available';
    }
  }

  async poll(
    yield_time_ms: number,
    max_output_chars: number,
    options?: {
      terminated?: boolean;
      stdin_closed?: boolean;
    },
  ): Promise<SessionPoll> {
    this.last_access = Date.now() / 1000;

    if (yield_time_ms > 0 && this.process.exitCode === null) {
      const wait_s = Math.min(yield_time_ms, MAX_YIELD_MS) / 1000;
      const remaining_s = this.deadline - Date.now() / 1000;
      const actual_wait_s = remaining_s <= 0 ? 0 : Math.min(wait_s, remaining_s);

      if (actual_wait_s > 0) {
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(() => {
            resolve();
          }, actual_wait_s * 1000);
          this.process.once('exit', () => {
            clearTimeout(timeout);
            resolve();
          });
        });
      }
    }

    if (this.process.exitCode === null && Date.now() / 1000 >= this.deadline) {
      this._timed_out = true;
      await this.kill();
    }

    if (this.process.exitCode !== null) {
      await new Promise<void>((resolve) => {
        const checkDone = () => {
          if (this._stdout_done && this._stderr_done) {
            resolve();
          } else {
            setTimeout(checkDone, 100);
          }
        };
        setTimeout(checkDone, 100);
        setTimeout(() => resolve(), 2000);
      });
    } else if (yield_time_ms > 0) {
      await this._waitForBufferedOutput();
    }

    let output = '';
    await this._withLock(() => {
      output = this._chunks.join('');
      this._chunks = [];
    });

    const truncated = this._truncateOutput(output, max_output_chars);
    return {
      output: truncated.output,
      done: this.process.exitCode !== null,
      exit_code: this.process.exitCode,
      elapsed_s: Math.max(0, Date.now() / 1000 - this.started_at),
      timed_out: this._timed_out,
      terminated: options?.terminated ?? false,
      stdin_closed: options?.stdin_closed ?? false,
      truncated_chars: truncated.omitted,
    };
  }

  async kill(): Promise<void> {
    if (this.process.exitCode !== null) return;
    this.process.kill('SIGKILL');
    await new Promise<void>((resolve) => {
      if (this.process.exitCode !== null) {
        resolve();
      } else {
        this.process.once('exit', () => resolve());
        setTimeout(() => resolve(), 5000);
      }
    });
  }

  private async _waitForBufferedOutput(): Promise<void> {
    const deadline = Date.now() + OUTPUT_DRAIN_GRACE_S;
    while (Date.now() < deadline) {
      let hasChunks = false;
      await this._withLock(() => {
        hasChunks = this._chunks.length > 0;
      });
      if (hasChunks) return;
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  private _truncateOutput(output: string, max_output_chars: number): { output: string; omitted: number } {
    if (output.length <= max_output_chars) {
      return { output, omitted: 0 };
    }
    const half = Math.floor(max_output_chars / 2);
    const omitted = output.length - max_output_chars;
    return {
      output: output.slice(0, half) + `\n\n... (${omitted.toLocaleString()} chars truncated) ...\n\n` + output.slice(-half),
      omitted,
    };
  }
}

export class ExecSessionManager {
  max_sessions: number;
  idle_timeout: number;
  private _sessions: Map<string, ExecSession> = new Map();
  private _lock: Promise<void> = Promise.resolve();

  constructor(options?: { max_sessions?: number; idle_timeout?: number }) {
    this.max_sessions = options?.max_sessions ?? 8;
    this.idle_timeout = options?.idle_timeout ?? 1800;
  }

  private async _withLock<T>(fn: () => Promise<T> | T): Promise<T> {
    const result = this._lock.then(() => fn());
    this._lock = result.then(() => undefined).catch(() => undefined);
    return result;
  }

  async start(options: {
    command: string;
    cwd: string;
    env?: Record<string, string>;
    timeout: number | null;
    shell_program?: string;
    login?: boolean;
    yield_time_ms: number;
    max_output_chars: number;
    owner_session_key: string | null;
  }): Promise<{ session_id: string; poll: SessionPoll }> {
    return this._withLock(async () => {
      await this._cleanupLocked();
      if (this._sessions.size >= this.max_sessions) {
        throw new Error(`maximum exec sessions reached (${this.max_sessions})`);
      }

      const proc = this._spawn(
        options.command,
        options.cwd,
        options.env || {},
        options.shell_program,
        options.login,
      );

      const session_id = crypto.randomBytes(6).toString('hex');
      const session = new ExecSession({
        session_id,
        process: proc,
        command: options.command,
        cwd: options.cwd,
        timeout: options.timeout,
        owner_session_key: options.owner_session_key,
      });

      this._sessions.set(session_id, session);

      const poll = await session.poll(options.yield_time_ms, options.max_output_chars);
      if (poll.done) {
        this._sessions.delete(session_id);
      }
      return { session_id, poll };
    });
  }

  async write(options: {
    session_id: string;
    chars: string | null;
    close_stdin: boolean;
    terminate: boolean;
    yield_time_ms: number;
    max_output_chars: number;
    owner_session_key: string | null;
  }): Promise<SessionPoll> {
    let session: ExecSession | undefined;
    await this._withLock(async () => {
      await this._cleanupLocked();
      session = this._sessions.get(options.session_id);
    });

    if (!session) {
      throw new Error(`exec session not found: ${options.session_id}`);
    }

    if (
      options.owner_session_key &&
      session.owner_session_key &&
      session.owner_session_key !== options.owner_session_key
    ) {
      throw new Error(`exec session not found: ${options.session_id}`);
    }

    if (options.chars) {
      const error = await session.write(options.chars);
      if (error) {
        throw new Error(error);
      }
    }

    let stdin_closed = false;
    if (options.close_stdin) {
      const error = await session.closeStdin();
      if (error) {
        throw new Error(error);
      }
      stdin_closed = true;
    }

    if (options.terminate) {
      await session.kill();
    }

    const poll = await session.poll(
      options.yield_time_ms,
      options.max_output_chars,
      { terminated: options.terminate, stdin_closed },
    );

    if (poll.done) {
      await this._withLock(() => {
        this._sessions.delete(options.session_id);
      });
    }

    return poll;
  }

  async list(owner_session_key: string | null): Promise<ExecSessionInfo[]> {
    return this._withLock(async () => {
      await this._cleanupLocked();
      const now = Date.now() / 1000;
      const result: ExecSessionInfo[] = [];
      for (const [session_id, session] of this._sessions.entries()) {
        if (
          owner_session_key &&
          session.owner_session_key &&
          session.owner_session_key !== owner_session_key
        ) {
          continue;
        }
        result.push({
          session_id,
          command: session.command,
          cwd: session.cwd,
          elapsed_s: Math.max(0, now - session.started_at),
          idle_s: Math.max(0, now - session.last_access),
          remaining_s: Math.max(0, session.deadline - now),
          returncode: session.process.exitCode,
          owner_session_key: session.owner_session_key,
        });
      }
      return result.sort((a, b) => a.session_id.localeCompare(b.session_id));
    });
  }

  private async _cleanupLocked(): Promise<void> {
    const now = Date.now() / 1000;
    const stale: string[] = [];
    for (const [session_id, session] of this._sessions.entries()) {
      if (now - session.last_access > this.idle_timeout) {
        stale.push(session_id);
      }
    }
    for (const session_id of stale) {
      const session = this._sessions.get(session_id);
      if (session) {
        await session.kill();
        this._sessions.delete(session_id);
      }
    }
  }

  private _spawn(
    command: string,
    cwd: string,
    env: Record<string, string>,
    shell_program?: string,
    login?: boolean,
  ): ChildProcessWithoutNullStreams {
    const shell = shell_program || process.env.SHELL || '/bin/sh';
    const args: string[] = [];
    if (login) {
      args.push('-l');
    }
    args.push('-c', command);

    return spawn(shell, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }
}

const DEFAULT_EXEC_SESSION_MANAGER = new ExecSessionManager();

function clampSessionInt(value: number | null | undefined, defaultVal: number, minimum: number, maximum: number): number {
  if (value === null || value === undefined) return defaultVal;
  return Math.min(Math.max(value, minimum), maximum);
}

function formatSessionPoll(session_id: string, poll: SessionPoll): string {
  const parts: string[] = [];
  if (poll.output) parts.push(poll.output);
  if (poll.truncated_chars) {
    parts.push(`(output truncated by ${poll.truncated_chars.toLocaleString()} chars)`);
  }
  if (poll.timed_out) {
    parts.push('Error: Command timed out; session was terminated.');
  }
  if (poll.terminated && !poll.timed_out) {
    parts.push('Session terminated.');
  }
  if (poll.stdin_closed) {
    parts.push('Stdin closed.');
  }
  if (poll.done) {
    parts.push(`Exit code: ${poll.exit_code}`);
  } else {
    parts.push(`Process running. session_id: ${session_id}`);
  }
  parts.push(`Elapsed: ${poll.elapsed_s.toFixed(1)}s`);
  return parts.length > 0 ? parts.join('\n') : '(no output yet)';
}

const WriteStdinSchema = z.object({
  session_id: z.string().describe('Session id returned by exec when yield_time_ms is used.'),
  chars: z.string().optional().nullable().describe(
    'Bytes/text to write to stdin. Omit or pass an empty string to only poll recent output.',
  ),
  close_stdin: z.boolean().optional().default(false).describe(
    'Close stdin after writing chars. Useful for commands waiting for EOF.',
  ),
  terminate: z.boolean().optional().default(false).describe(
    'Terminate the running exec session.',
  ),
  yield_time_ms: z.number().int().min(0).max(MAX_YIELD_MS).optional().describe(
    'Milliseconds to wait before returning recent output (default 1000, max 30000).',
  ),
  wait_for: z.string().optional().nullable().describe(
    'Optional text to wait for in output before returning. ' +
    'Useful for interactive commands and dev servers.',
  ),
  wait_timeout_ms: z.number().int().min(0).max(MAX_WAIT_FOR_MS).optional().nullable().describe(
    'Maximum milliseconds to wait for wait_for text (default 10000, max 120000).',
  ),
  max_output_chars: z.number().int().min(1000).max(MAX_OUTPUT_CHARS).optional().describe(
    'Maximum output characters to return from this poll (default 10000, max 50000).',
  ),
  max_output_tokens: z.number().int().min(1000).max(MAX_OUTPUT_CHARS).optional().nullable().describe(
    'Compatibility alias for max_output_chars. The current runtime uses a character budget.',
  ),
});

export class WriteStdinTool extends BaseTool {
  name = 'write_stdin';
  description = (
    'Interact with a running exec session created by exec with ' +
    'yield_time_ms. Use chars=\'\' to poll without writing, chars to send ' +
    'stdin, close_stdin=true to send EOF, or terminate=true to stop the ' +
    'process. Use wait_for with wait_timeout_ms for dev servers, test ' +
    'watchers, and prompts where you need to wait for expected output. ' +
    'Do not use this to start new commands; start them with exec.'
  );
  input_schema = WriteStdinSchema;
  tags = ['exec', 'session', 'stdin'];

  private _manager: ExecSessionManager;

  constructor(manager?: ExecSessionManager) {
    super();
    this._manager = manager || DEFAULT_EXEC_SESSION_MANAGER;
  }

  async execute(args: unknown, _context: ToolContext): Promise<ToolResult> {
    try {
      const params = this.input_schema.parse(args);

      let max_output_chars = params.max_output_chars;
      if (max_output_chars === undefined) {
        max_output_chars = params.max_output_tokens ?? undefined;
      }
      const output_limit = clampSessionInt(
        max_output_chars,
        DEFAULT_MAX_OUTPUT_CHARS,
        1000,
        MAX_OUTPUT_CHARS,
      );

      if (params.wait_for) {
        return this._waitForOutput({
          session_id: params.session_id,
          chars: params.chars,
          close_stdin: params.close_stdin,
          terminate: params.terminate,
          wait_for: params.wait_for,
          wait_timeout_ms: clampSessionInt(
            params.wait_timeout_ms,
            DEFAULT_WAIT_FOR_MS,
            0,
            MAX_WAIT_FOR_MS,
          ),
          max_output_chars: output_limit,
        });
      }

      const poll = await this._manager.write({
        session_id: params.session_id,
        chars: params.chars ?? null,
        close_stdin: params.close_stdin,
        terminate: params.terminate,
        yield_time_ms: clampSessionInt(params.yield_time_ms, DEFAULT_YIELD_MS, 0, MAX_YIELD_MS),
        max_output_chars: output_limit,
        owner_session_key: currentRequestSessionKey(),
      });

      const result = formatSessionPoll(params.session_id, poll);
      if (poll.timed_out) {
        return createToolError(result);
      }
      return createToolResult(result);
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.startsWith('exec session not found')) {
        return createToolError(`Error: ${msg}`);
      }
      return createToolError(`Error writing to exec session: ${msg}`);
    }
  }

  private async _waitForOutput(options: {
    session_id: string;
    chars: string | null | undefined;
    close_stdin: boolean;
    terminate: boolean;
    wait_for: string;
    wait_timeout_ms: number;
    max_output_chars: number;
  }): Promise<ToolResult> {
    const deadline = Date.now() + options.wait_timeout_ms;
    const aggregate: string[] = [];
    let first = true;
    let poll: SessionPoll | null = null;

    while (true) {
      const remaining_ms = Math.max(0, deadline - Date.now());
      const step_ms = Math.min(500, remaining_ms);
      poll = await this._manager.write({
        session_id: options.session_id,
        chars: first ? options.chars ?? null : null,
        close_stdin: first ? options.close_stdin : false,
        terminate: first ? options.terminate : false,
        yield_time_ms: step_ms,
        max_output_chars: options.max_output_chars,
        owner_session_key: currentRequestSessionKey(),
      });
      first = false;

      if (poll.output) {
        aggregate.push(poll.output);
        const joined = aggregate.join('');
        if (joined.includes(options.wait_for)) {
          poll.output = joined;
          const result = formatSessionPoll(options.session_id, poll);
          if (poll.timed_out) {
            return createToolError(result);
          }
          return createToolResult(result);
        }
      }

      if (poll.done || remaining_ms <= 0) {
        poll.output = aggregate.join('');
        let result = formatSessionPoll(options.session_id, poll);
        if (!poll.output.includes(options.wait_for)) {
          result += `\nWait target not observed: ${JSON.stringify(options.wait_for)}`;
        }
        if (poll.timed_out) {
          return createToolError(result);
        }
        return createToolResult(result);
      }
    }
  }
}

const ListExecSessionsSchema = z.object({});

export class ListExecSessionsTool extends BaseTool {
  name = 'list_exec_sessions';
  description = (
    'List active long-running exec sessions, including session_id, cwd, ' +
    'elapsed time, idle time, remaining timeout, and command preview. ' +
    'Use this to recover a session_id after context shifts before ' +
    'polling, writing stdin, or terminating with write_stdin.'
  );
  input_schema = ListExecSessionsSchema;
  tags = ['exec', 'session', 'list'];

  private _manager: ExecSessionManager;

  constructor(manager?: ExecSessionManager) {
    super();
    this._manager = manager || DEFAULT_EXEC_SESSION_MANAGER;
  }

  async execute(_args: unknown, _context: ToolContext): Promise<ToolResult> {
    try {
      const sessions = await this._manager.list(currentRequestSessionKey());
      if (sessions.length === 0) {
        return createToolResult('No active exec sessions.');
      }
      const lines: string[] = [];
      for (const info of sessions) {
        let command = info.command.replace(/\s+/g, ' ');
        if (command.length > 120) {
          command = command.slice(0, 119) + '...';
        }
        const status = info.returncode !== null ? 'exited' : 'running';
        lines.push(
          `${info.session_id} | ${status} | elapsed=${info.elapsed_s.toFixed(1)}s ` +
          `| idle=${info.idle_s.toFixed(1)}s | remaining=${info.remaining_s.toFixed(1)}s ` +
          `| cwd=${info.cwd} | ${command}`,
        );
      }
      return createToolResult(lines.join('\n'));
    } catch (e) {
      return createToolError(`Error listing exec sessions: ${(e as Error).message}`);
    }
  }
}

export function getExecSessionTools(manager?: ExecSessionManager): BaseTool[] {
  return [
    new WriteStdinTool(manager),
    new ListExecSessionsTool(manager),
  ];
}

export {
  DEFAULT_EXEC_SESSION_MANAGER,
  formatSessionPoll,
  clampSessionInt,
};
