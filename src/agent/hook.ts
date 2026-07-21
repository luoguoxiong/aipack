export interface AgentHookContext {
  session_key: string;
  channel: string;
  chat_id: string;
  sender_id: string;
  runtime?: unknown;
  turn_id?: string;
  extras?: Record<string, unknown>;
}

export interface AgentRunHookContext extends AgentHookContext {
  messages?: unknown[];
  tools?: unknown;
}

export interface AgentToolHookContext extends AgentHookContext {
  tool_name: string;
  tool_call_id: string;
  arguments?: unknown;
  result?: unknown;
  error?: string;
}

export abstract class AgentHook {
  name = 'base';

  wantsStreaming(): boolean {
    return false;
  }

  async onTurnStart(_context: AgentHookContext): Promise<void> {}
  async onTurnEnd(_context: AgentHookContext, _result: unknown): Promise<void> {}
  async onTurnError(_context: AgentHookContext, _error: Error): Promise<void> {}

  async onToolStart(_context: AgentToolHookContext): Promise<void> {}
  async onToolEnd(_context: AgentToolHookContext): Promise<void> {}
  async onToolError(_context: AgentToolHookContext): Promise<void> {}

  async onStreamDelta(_context: AgentHookContext, _delta: string): Promise<void> {}
  async onStreamEnd(_context: AgentHookContext): Promise<void> {}

  finalizeContent(_context: AgentHookContext, content: string | null): string | null {
    return content;
  }
}

export class SDKCaptureHook extends AgentHook {
  name = 'sdk_capture';
  private captured: {
    tools: Array<{ name: string; id: string; status: string; result?: string; error?: string }>;
  } = { tools: [] };

  async onToolStart(context: AgentToolHookContext): Promise<void> {
    this.captured.tools.push({
      name: context.tool_name,
      id: context.tool_call_id,
      status: 'started',
    });
  }

  async onToolEnd(context: AgentToolHookContext): Promise<void> {
    const tool = this.captured.tools.find(t => t.id === context.tool_call_id);
    if (tool) {
      tool.status = 'completed';
      tool.result = String(context.result || '');
    }
  }

  async onToolError(context: AgentToolHookContext): Promise<void> {
    const tool = this.captured.tools.find(t => t.id === context.tool_call_id);
    if (tool) {
      tool.status = 'failed';
      tool.error = context.error;
    }
  }

  getCaptured() {
    return { ...this.captured };
  }
}

export interface StreamingEmitter {
  textDelta: (delta: string) => Promise<void>;
  textCompleted: (options?: { resuming?: boolean; force?: boolean }) => Promise<void>;
  toolStarted: (name: string, id: string) => Promise<void>;
  toolCompleted: (name: string, id: string) => Promise<void>;
  toolFailed: (name: string, id: string, error: string) => Promise<void>;
  reasoningDelta: (delta: string) => Promise<void>;
  reasoningCompleted: () => Promise<void>;
}

export class StreamingHook extends AgentHook {
  name = 'streaming';
  private emitter: StreamingEmitter;

  constructor(emitter: StreamingEmitter) {
    super();
    this.emitter = emitter;
  }

  async onStreamDelta(_context: AgentHookContext, delta: string): Promise<void> {
    await this.emitter.textDelta(delta);
  }

  async onStreamEnd(_context: AgentHookContext): Promise<void> {
    await this.emitter.textCompleted();
  }

  async onToolStart(context: AgentToolHookContext): Promise<void> {
    await this.emitter.toolStarted(context.tool_name, context.tool_call_id);
  }

  async onToolEnd(context: AgentToolHookContext): Promise<void> {
    await this.emitter.toolCompleted(context.tool_name, context.tool_call_id);
  }

  async onToolError(context: AgentToolHookContext): Promise<void> {
    await this.emitter.toolFailed(context.tool_name, context.tool_call_id, context.error || '');
  }
}
