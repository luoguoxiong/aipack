import crypto from 'crypto';
import { AgentHook, AgentHookContext } from './hook.js';
import { AgentRunner, AgentRunResult } from './runner.js';
import { ToolRegistry, createDefaultToolRegistry } from './tools/registry.js';
import { MessageBus, InboundMessage } from '../bus/queue.js';
import { LLMRuntime, LLMProvider, ProviderMessage } from '../providers/base.js';
import { logger } from '../utils/logger.js';
import { generateId } from '../utils/helpers.js';

export type SubagentPhase =
  | 'initializing'
  | 'awaiting_tools'
  | 'tools_completed'
  | 'final_response'
  | 'done'
  | 'error';

export interface SubagentStatus {
  taskId: string;
  label: string;
  taskDescription: string;
  startedAt: number;
  phase: SubagentPhase;
  iteration: number;
  toolEvents: Array<{ name: string; id: string; status: string; result?: string; error?: string }>;
  usage: Record<string, number>;
  stopReason: string | null;
  error: string | null;
}

class SubagentHook extends AgentHook {
  private _taskId: string;
  private _status: SubagentStatus | null;

  constructor(taskId: string, status: SubagentStatus | null = null) {
    super();
    this._taskId = taskId;
    this._status = status;
  }

  async onToolStart(context: AgentHookContext & { tool_name: string; tool_call_id: string }): Promise<void> {
    logger.debug(
      { taskId: this._taskId, tool: context.tool_name },
      'Subagent executing tool',
    );
  }
}

export interface SubagentManagerOptions {
  workspace: string;
  bus: MessageBus;
  maxToolResultChars: number;
  provider?: LLMProvider;
  model?: string;
  restrictToWorkspace?: boolean;
  disabledSkills?: string[];
  maxIterations?: number;
  maxConcurrentSubagents?: number;
  failOnToolError?: boolean;
}

export class SubagentManager {
  private workspace: string;
  private bus: MessageBus;
  private maxToolResultChars: number;
  private restrictToWorkspace: boolean;
  private disabledSkills: Set<string>;
  private maxIterations: number;
  private maxConcurrentSubagents: number;
  private failOnToolError: boolean;
  private runner: AgentRunner;
  private _compatRuntime: LLMRuntime | null = null;
  private _provider: LLMProvider | null = null;
  private _runningTasks: Map<string, Promise<void>> = new Map();
  private _taskStatuses: Map<string, SubagentStatus> = new Map();
  private _sessionTasks: Map<string, Set<string>> = new Map();

  constructor(options: SubagentManagerOptions) {
    this.workspace = options.workspace;
    this.bus = options.bus;
    this.maxToolResultChars = options.maxToolResultChars;
    this.restrictToWorkspace = options.restrictToWorkspace ?? false;
    this.disabledSkills = new Set(options.disabledSkills || []);
    this.maxIterations = options.maxIterations ?? 200;
    this.maxConcurrentSubagents = options.maxConcurrentSubagents ?? 1;
    this.failOnToolError = options.failOnToolError ?? true;
    this.runner = new AgentRunner();
    this._provider = options.provider ?? null;

    if (options.provider && options.model) {
      this._compatRuntime = {
        model: options.model,
        provider: options.provider.name,
        max_tokens: 8192,
        context_window_tokens: 200000,
        temperature: 0.1,
        reasoning_effort: null,
        model_preset: null,
      };
    }
  }

  setProvider(provider: LLMProvider, model: string): void {
    this._provider = provider;
    this._compatRuntime = {
      model,
      provider: provider.name,
      max_tokens: 8192,
      context_window_tokens: 200000,
      temperature: 0.1,
      reasoning_effort: null,
      model_preset: null,
    };
  }

  private _buildTools(): ToolRegistry {
    return createDefaultToolRegistry();
  }

  async spawn(
    task: string,
    options: {
      label?: string;
      originChannel?: string;
      originChatId?: string;
      sessionKey?: string;
      originMessageId?: string;
      temperature?: number;
      runtime?: LLMRuntime;
    } = {},
  ): Promise<string> {
    let runtime = options.runtime ?? this._compatRuntime;
    if (!runtime) {
      throw new TypeError('SubagentManager.spawn() requires runtime parameter');
    }
    if (options.temperature !== undefined) {
      runtime = { ...runtime, temperature: options.temperature };
    }

    const taskId = crypto.randomBytes(4).toString('hex');
    const displayLabel = options.label || (task.length > 30 ? task.slice(0, 30) + '...' : task);
    const origin = {
      channel: options.originChannel || 'cli',
      chat_id: options.originChatId || 'direct',
      session_key: options.sessionKey,
    };

    const status: SubagentStatus = {
      taskId,
      label: displayLabel,
      taskDescription: task,
      startedAt: Date.now(),
      phase: 'initializing',
      iteration: 0,
      toolEvents: [],
      usage: {},
      stopReason: null,
      error: null,
    };
    this._taskStatuses.set(taskId, status);

    const bgTask = this._runSubagent(
      taskId,
      task,
      displayLabel,
      origin,
      status,
      runtime,
      options.originMessageId,
    );

    this._runningTasks.set(taskId, bgTask);
    if (options.sessionKey) {
      if (!this._sessionTasks.has(options.sessionKey)) {
        this._sessionTasks.set(options.sessionKey, new Set());
      }
      this._sessionTasks.get(options.sessionKey)!.add(taskId);
    }

    bgTask.finally(() => {
      this._runningTasks.delete(taskId);
      this._taskStatuses.delete(taskId);
      if (options.sessionKey) {
        const tasks = this._sessionTasks.get(options.sessionKey);
        if (tasks) {
          tasks.delete(taskId);
          if (tasks.size === 0) {
            this._sessionTasks.delete(options.sessionKey);
          }
        }
      }
    });

    logger.info({ taskId, label: displayLabel }, 'Spawned subagent');
    return `Subagent [${displayLabel}] started (id: ${taskId}). I'll notify you when it completes.`;
  }

  private async _runSubagent(
    taskId: string,
    task: string,
    label: string,
    origin: { channel: string; chat_id: string; session_key?: string },
    status: SubagentStatus,
    runtime: LLMRuntime,
    originMessageId?: string,
  ): Promise<void> {
    logger.info({ taskId, label }, 'Subagent starting task');

    try {
      const tools = this._buildTools();
      const systemPrompt = this._buildSubagentPrompt();
      const messages: ProviderMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: task },
      ];

      if (!this._provider) {
        throw new Error('No provider configured for subagent');
      }

      const result = await this.runner.run({
        initialMessages: messages,
        tools,
        runtime,
        provider: this._provider,
        maxIterations: this.maxIterations,
        maxToolResultChars: this.maxToolResultChars,
        workspace: this.workspace,
        sessionKey: origin.session_key,
        channel: origin.channel,
        chatId: origin.chat_id,
        senderId: 'subagent',
      });

      status.phase = 'done';
      status.stopReason = result.stopReason;
      status.toolEvents = result.toolEvents;
      status.usage = result.usage;

      if (result.stopReason === 'error') {
        await this._announceResult(
          taskId,
          label,
          task,
          result.error || 'Error: subagent execution failed.',
          origin,
          'error',
          originMessageId,
        );
      } else {
        const finalResult = result.finalContent || 'Task completed but no final response was generated.';
        logger.info({ taskId }, 'Subagent completed successfully');
        await this._announceResult(taskId, label, task, finalResult, origin, 'ok', originMessageId);
      }
    } catch (err) {
      status.phase = 'error';
      status.error = (err as Error).message;
      logger.error({ err, taskId }, 'Subagent failed');
      await this._announceResult(
        taskId,
        label,
        task,
        `Error: ${(err as Error).message}`,
        origin,
        'error',
        originMessageId,
      );
    }
  }

  private async _announceResult(
    taskId: string,
    label: string,
    task: string,
    result: string,
    origin: { channel: string; chat_id: string; session_key?: string },
    status: 'ok' | 'error',
    originMessageId?: string,
  ): Promise<void> {
    const statusText = status === 'ok' ? 'completed successfully' : 'failed';

    const announceContent = `## Subagent Result: ${label}\n\n**Status:** ${statusText}\n\n**Task:** ${task}\n\n**Result:**\n${result}`;

    const override = origin.session_key || `${origin.channel}:${origin.chat_id}`;
    const metadata: Record<string, unknown> = {
      injected_event: 'subagent_result',
      subagent_task_id: taskId,
    };
    if (originMessageId) {
      metadata['origin_message_id'] = originMessageId;
    }

    const msg: InboundMessage = {
      id: generateId('subagent_'),
      channel: 'system',
      sender_id: 'subagent',
      chat_id: `${origin.channel}:${origin.chat_id}`,
      text: announceContent,
      timestamp: new Date().toISOString(),
      metadata,
      session_key: override,
    };

    this.bus.publish({ type: 'inbound_message', payload: msg });
    logger.debug({ taskId }, 'Subagent announced result');
  }

  private _buildSubagentPrompt(): string {
    return `# Subagent

You are a subagent working on a specific task. Focus on completing the task efficiently.

**Workspace:** ${this.workspace}

Guidelines:
- Complete the task to the best of your ability
- Use tools as needed
- Provide a clear final summary when done`;
  }

  async cancelBySession(sessionKey: string): Promise<number> {
    const taskIds = this._sessionTasks.get(sessionKey);
    if (!taskIds) return 0;

    let count = 0;
    for (const taskId of taskIds) {
      const task = this._runningTasks.get(taskId);
      if (task) {
        count++;
      }
    }
    return count;
  }

  getRunningCount(): number {
    return this._runningTasks.size;
  }

  getRunningCountBySession(sessionKey: string): number {
    const taskIds = this._sessionTasks.get(sessionKey);
    if (!taskIds) return 0;
    let count = 0;
    for (const taskId of taskIds) {
      if (this._runningTasks.has(taskId)) {
        count++;
      }
    }
    return count;
  }

  getStatus(taskId: string): SubagentStatus | undefined {
    return this._taskStatuses.get(taskId);
  }
}
