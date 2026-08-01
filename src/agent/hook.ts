import type { AgentEvent, AgentMessage } from "./types";
import type { AgentHook as AgentHookInterface, AgentHookContext, AgentRunHookContext, AgentToolHookContext, StreamingEmitter } from "./types";

export type { AgentHookContext, AgentRunHookContext, AgentToolHookContext, StreamingEmitter };

export class StreamingHook implements StreamingEmitter {
  private listeners = new Set<(event: AgentEvent) => void>();

  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: AgentEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

export class SDKCaptureHook implements AgentHookInterface {
  private capturedEvents: AgentEvent[] = [];

  get events(): AgentEvent[] {
    return [...this.capturedEvents];
  }

  onMessage(context: AgentHookContext): void {
    this.capturedEvents.push(context.event);
  }

  onToolCall(context: AgentToolHookContext): void {
    this.capturedEvents.push({
      type: "tool_started",
      toolCallId: context.toolCallId,
      toolName: context.toolName,
      args: context.args,
    });
  }

  onToolResult(context: AgentToolHookContext): void {
    this.capturedEvents.push({
      type: "tool_finished",
      toolCallId: context.toolCallId,
      toolName: context.toolName,
      result: context.result as any,
      isError: false,
    });
  }

  clear(): void {
    this.capturedEvents = [];
  }
}

export class AgentHookManager {
  private hooks: AgentHookInterface[] = [];

  register(hook: AgentHookInterface): void {
    this.hooks.push(hook);
  }

  async emitStart(messages: AgentMessage[], signal: AbortSignal): Promise<void> {
    for (const hook of this.hooks) {
      if (hook.onStart) {
        await hook.onStart({ event: { type: "agent_started" }, messages, signal });
      }
    }
  }

  async emitMessage(event: AgentEvent, signal: AbortSignal): Promise<void> {
    for (const hook of this.hooks) {
      if (hook.onMessage) {
        await hook.onMessage({ event, signal });
      }
    }
  }

  async emitToolCall(toolName: string, toolCallId: string, args: unknown, signal: AbortSignal): Promise<void> {
    for (const hook of this.hooks) {
      if (hook.onToolCall) {
        await hook.onToolCall({
          event: { type: "tool_started", toolCallId, toolName, args },
          toolName,
          toolCallId,
          args,
          signal,
        });
      }
    }
  }

  async emitToolResult(toolName: string, toolCallId: string, result: unknown, signal: AbortSignal): Promise<void> {
    for (const hook of this.hooks) {
      if (hook.onToolResult) {
        await hook.onToolResult({
          event: { type: "tool_finished", toolCallId, toolName, result: result as any, isError: false },
          toolName,
          toolCallId,
          args: {},
          result,
          signal,
        });
      }
    }
  }

  async emitEnd(messages: AgentMessage[], signal: AbortSignal): Promise<void> {
    for (const hook of this.hooks) {
      if (hook.onEnd) {
        await hook.onEnd({ event: { type: "agent_finished", messages }, messages, signal });
      }
    }
  }
}

export { AgentHookManager as AgentHook };
