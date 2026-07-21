import { BaseTool, ToolContext, ToolResult, createToolResult, createToolError } from './base.js';
import { z } from 'zod';
import { currentRequestContext } from './context.js';

const SpawnSchema = z.object({
  task: z.string().describe('The task for the subagent to complete'),
  label: z.string().optional().describe('Optional short label for the task (for display)'),
  temperature: z.number().min(0).max(2).optional().describe(
    'Optional sampling temperature for the subagent ' +
    '(0.0 = deterministic, higher = more creative). ' +
    "Defaults to the provider's configured temperature.",
  ),
});

export interface SubagentManagerLike {
  max_concurrent_subagents: number;
  getRunningCount(): number;
  spawn(options: {
    task: string;
    runtime?: unknown;
    label?: string;
    origin_channel: string;
    origin_chat_id: string;
    session_key: string;
    origin_message_id?: string;
    temperature?: number;
    workspace_scope?: string;
  }): Promise<string>;
}

export class SpawnTool extends BaseTool {
  name = 'spawn';
  description = (
    'Spawn a subagent to handle a task in the background. ' +
    'Use this for complex or time-consuming tasks that can run independently. ' +
    'The subagent will complete the task and report back when done. ' +
    'For deliverables or existing projects, inspect the workspace first ' +
    'and use a dedicated subdirectory when helpful.'
  );
  input_schema = SpawnSchema;
  tags = ['subagent', 'spawn'];

  private _manager: SubagentManagerLike | null = null;

  constructor(manager?: SubagentManagerLike) {
    super();
    this._manager = manager ?? null;
  }

  setManager(manager: SubagentManagerLike): void {
    this._manager = manager;
  }

  async execute(args: unknown, _context: ToolContext): Promise<ToolResult> {
    try {
      const params = this.input_schema.parse(args);

      if (!this._manager) {
        return createToolError('Error: spawn tool is not configured (no subagent manager)');
      }

      const running = this._manager.getRunningCount();
      const limit = this._manager.max_concurrent_subagents;
      if (running >= limit) {
        return createToolError(
          `Cannot spawn subagent: concurrency limit reached ` +
          `(${running}/${limit} running). Wait for a running subagent ` +
          'to complete before spawning a new one.',
        );
      }

      const requestCtx = currentRequestContext();
      if (!requestCtx || !requestCtx.runtime) {
        return createToolError('Error: spawn requires an active model runtime');
      }

      const originChannel = requestCtx.channel;
      const originChatId = requestCtx.chat_id;
      const sessionKey = requestCtx.session_key || `${originChannel}:${originChatId}`;

      const result = await this._manager.spawn({
        task: params.task,
        runtime: requestCtx.runtime,
        label: params.label,
        origin_channel: originChannel,
        origin_chat_id: originChatId,
        session_key: sessionKey,
        origin_message_id: requestCtx.message_id,
        temperature: params.temperature,
      });

      return createToolResult(result);
    } catch (e) {
      return createToolError(`Error spawning subagent: ${(e as Error).message}`);
    }
  }
}

export function getSpawnTools(manager?: SubagentManagerLike): BaseTool[] {
  return [new SpawnTool(manager)];
}
