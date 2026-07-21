import type { InboundMessage, OutboundMessage } from '../bus/queue.js';

export type CommandHandler = (ctx: CommandContext) => Promise<OutboundMessage | null>;

const _BOT_SUFFIX_RE = /^[A-Za-z0-9_]+$/;

export function normalizeCommandText(text: string): string {
  const stripped = text.trim();
  if (!stripped.startsWith('/')) {
    return stripped;
  }
  const firstSpaceIdx = stripped.indexOf(' ');
  const first = firstSpaceIdx === -1 ? stripped : stripped.slice(0, firstSpaceIdx);
  const rest = firstSpaceIdx === -1 ? '' : stripped.slice(firstSpaceIdx);

  if (!first.includes('@')) {
    return stripped;
  }

  const lastAtIdx = first.lastIndexOf('@');
  const command = first.slice(0, lastAtIdx);
  const suffix = first.slice(lastAtIdx + 1);

  if (command && suffix && _BOT_SUFFIX_RE.test(suffix)) {
    return command + rest;
  }
  return stripped;
}

export interface CommandContext {
  msg: InboundMessage;
  session: unknown | null;
  key: string;
  raw: string;
  args: string;
  loop: unknown;
  runtime: unknown | null;
  is_user_turn: boolean;
  turn_scopes: unknown[];
}

export class CommandRouter {
  private _priority: Map<string, CommandHandler> = new Map();
  private _exact: Map<string, CommandHandler> = new Map();
  private _prefix: Array<{ prefix: string; handler: CommandHandler }> = [];

  priority(cmd: string, handler: CommandHandler): void {
    this._priority.set(cmd, handler);
  }

  exact(cmd: string, handler: CommandHandler): void {
    this._exact.set(cmd, handler);
  }

  prefix(pfx: string, handler: CommandHandler): void {
    this._prefix.push({ prefix: pfx, handler });
    this._prefix.sort((a, b) => b.prefix.length - a.prefix.length);
  }

  isPriority(text: string): boolean {
    return this._priority.has(normalizeCommandText(text).toLowerCase());
  }

  isDispatchableCommand(text: string): boolean {
    const cmd = normalizeCommandText(text).toLowerCase();
    if (this._exact.has(cmd)) {
      return true;
    }
    for (const { prefix } of this._prefix) {
      if (cmd.startsWith(prefix)) {
        return true;
      }
    }
    return false;
  }

  async dispatchPriority(ctx: CommandContext): Promise<OutboundMessage | null> {
    ctx.raw = normalizeCommandText(ctx.raw);
    const handler = this._priority.get(ctx.raw.toLowerCase());
    if (handler) {
      return await handler(ctx);
    }
    return null;
  }

  async dispatch(ctx: CommandContext): Promise<OutboundMessage | null> {
    ctx.raw = normalizeCommandText(ctx.raw);
    const cmd = ctx.raw.toLowerCase();

    const exactHandler = this._exact.get(cmd);
    if (exactHandler) {
      return await exactHandler(ctx);
    }

    for (const { prefix, handler } of this._prefix) {
      if (cmd.startsWith(prefix)) {
        ctx.args = ctx.raw.slice(prefix.length);
        return await handler(ctx);
      }
    }

    return null;
  }
}
