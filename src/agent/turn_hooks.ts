import { AgentHook, AgentHookContext } from './hook.js';
import { AgentProgressHook, ProgressCallback } from './progress_hook.js';
import { logger } from '../utils/logger.js';

export type AgentTurnHookFactory = (context: AgentTurnHookContext) => AgentHook | null;

export interface AgentTurnHookContext {
  onProgress: ProgressCallback | null;
  workspace?: string | null;
  channel: string;
  chatId: string;
  messageId?: string | null;
  sessionKey?: string | null;
  metadata: Record<string, unknown>;
  ephemeral: boolean;
}

export interface AgentTurnHookSpec {
  onProgress?: ProgressCallback | null;
  onStream?: ((delta: string) => Promise<void>) | null;
  onStreamEnd?: ((options?: { resuming?: boolean }) => Promise<void>) | null;
  channel?: string;
  chatId?: string;
  messageId?: string | null;
  metadata?: Record<string, unknown> | null;
  sessionKey?: string | null;
  workspace?: string | null;
  toolHintMaxLength?: number;
  onIteration?: ((iteration: number) => void) | null;
  registeredHookFactories?: AgentTurnHookFactory[];
  turnHookFactories?: AgentTurnHookFactory[];
  registeredHooks?: AgentHook[];
  turnHooks?: AgentHook[];
  ephemeral?: boolean;
  runExtraHooksForEphemeral?: boolean;
}

export class CompositeHook extends AgentHook {
  private _hooks: AgentHook[];

  constructor(hooks: AgentHook[]) {
    super();
    this._hooks = [...hooks];
  }

  wantsStreaming(): boolean {
    return this._hooks.some(h => h.wantsStreaming());
  }

  private async _forEachHookSafe(
    methodName: keyof AgentHook,
    ...args: unknown[]
  ): Promise<void> {
    for (const h of this._hooks) {
      try {
        const method = (h as unknown as Record<string, (...args: unknown[]) => Promise<void>>)[methodName as string];
        if (typeof method === 'function') {
          await method.apply(h, args);
        }
      } catch (err) {
        logger.error(
          { err, hook: h.constructor.name, method: methodName },
          'AgentHook error',
        );
      }
    }
  }

  async onTurnStart(context: AgentHookContext): Promise<void> {
    await this._forEachHookSafe('onTurnStart', context);
  }

  async onTurnEnd(context: AgentHookContext, result: unknown): Promise<void> {
    await this._forEachHookSafe('onTurnEnd', context, result);
  }

  async onTurnError(context: AgentHookContext, error: Error): Promise<void> {
    await this._forEachHookSafe('onTurnError', context, error);
  }

  async onToolStart(context: AgentHookContext & { tool_name: string; tool_call_id: string; arguments?: unknown }): Promise<void> {
    await this._forEachHookSafe('onToolStart', context);
  }

  async onToolEnd(context: AgentHookContext & { tool_name: string; tool_call_id: string; result?: string }): Promise<void> {
    await this._forEachHookSafe('onToolEnd', context);
  }

  async onToolError(context: AgentHookContext & { tool_name: string; tool_call_id: string; error?: string }): Promise<void> {
    await this._forEachHookSafe('onToolError', context);
  }

  async onStreamDelta(context: AgentHookContext, delta: string): Promise<void> {
    await this._forEachHookSafe('onStreamDelta', context, delta);
  }

  async onStreamEnd(context: AgentHookContext): Promise<void> {
    await this._forEachHookSafe('onStreamEnd', context);
  }
}

export function buildAgentTurnHook(spec: AgentTurnHookSpec): AgentHook {
  const progressHook = new AgentProgressHook({
    onProgress: spec.onProgress,
    onStream: spec.onStream,
    onStreamEnd: spec.onStreamEnd,
    sessionKey: spec.sessionKey,
    toolHintMaxLength: spec.toolHintMaxLength ?? 40,
    onIteration: spec.onIteration,
  });

  const ephemeral = spec.ephemeral ?? false;
  const runExtraHooksForEphemeral = spec.runExtraHooksForEphemeral ?? false;

  if (ephemeral && !runExtraHooksForEphemeral) {
    return progressHook;
  }

  const turnContext: AgentTurnHookContext = {
    onProgress: spec.onProgress ?? null,
    workspace: spec.workspace,
    channel: spec.channel ?? 'cli',
    chatId: spec.chatId ?? 'direct',
    messageId: spec.messageId,
    sessionKey: spec.sessionKey,
    metadata: { ...(spec.metadata || {}) },
    ephemeral,
  };

  const hookChain: AgentHook[] = [progressHook];

  for (const factory of spec.registeredHookFactories || []) {
    try {
      const createdHook = factory(turnContext);
      if (createdHook !== null) {
        hookChain.push(createdHook);
      }
    } catch (err) {
      logger.error({ err, factory: factory.name }, 'Agent turn hook factory failed');
    }
  }

  hookChain.push(...(spec.registeredHooks || []));

  for (const factory of spec.turnHookFactories || []) {
    try {
      const createdHook = factory(turnContext);
      if (createdHook !== null) {
        hookChain.push(createdHook);
      }
    } catch (err) {
      logger.error({ err, factory: factory.name }, 'Agent turn hook factory failed');
    }
  }

  hookChain.push(...(spec.turnHooks || []));

  if (hookChain.length > 1) {
    return new CompositeHook(hookChain);
  }
  return progressHook;
}
