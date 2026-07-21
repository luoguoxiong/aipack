import { AsyncLocalStorage } from 'async_hooks';

export interface RequestContext {
  channel: string;
  chat_id: string;
  message_id?: string;
  session_key?: string;
  original_user_text?: string;
  runtime?: unknown;
  metadata: Record<string, unknown>;
  sender_id?: string;
  turn_id?: string;
  workspace?: string;
}

export interface ContextAware {
  setContext(ctx: RequestContext): void;
}

const _CURRENT_REQUEST_CONTEXT = new AsyncLocalStorage<RequestContext | null>();

export function bindRequestContext(ctx: RequestContext): void {
  _CURRENT_REQUEST_CONTEXT.enterWith(ctx);
}

export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return _CURRENT_REQUEST_CONTEXT.run(ctx, fn);
}

export function currentRequestContext(): RequestContext | null {
  return _CURRENT_REQUEST_CONTEXT.getStore() ?? null;
}

export function currentRequestSessionKey(): string | null {
  const ctx = currentRequestContext();
  return ctx?.session_key ?? null;
}

export interface ToolConstructionContext {
  config: unknown;
  workspace: string;
  bus?: unknown;
  subagent_manager?: unknown;
  cron_service?: unknown;
  sessions?: unknown;
  file_state_store?: unknown;
  provider_snapshot_loader?: () => unknown;
  image_generation_provider_configs?: Record<string, unknown>;
  timezone: string;
  workspace_sandbox?: unknown;
  runtime_events?: unknown;
}
