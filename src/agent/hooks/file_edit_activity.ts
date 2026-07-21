import { AgentHook, AgentHookContext, AgentRunHookContext } from '../hook.js';
import { ToolCallRequest } from '../../providers/base.js';
import { AgentTurnHookContext } from '../turn_hooks.js';
import { ProgressCallback } from '../progress_hook.js';
import { logger } from '../../utils/logger.js';

export interface FileEditEvent {
  type: 'file_edit_start' | 'file_edit_end' | 'file_edit_error';
  call_id: string;
  tool_name: string;
  file_path?: string;
  action?: string;
  error?: string;
}

export interface FileEditTracker {
  callId: string;
  toolName: string;
  filePath?: string;
  action?: string;
}

const FILE_EDIT_TOOLS = new Set([
  'write_file',
  'edit_file',
  'apply_patch',
  'delete_file',
  'rename_file',
  'create_directory',
  'remove_directory',
]);

function prepareFileEditTrackers(
  callId: string,
  toolName: string,
  params: unknown,
): FileEditTracker[] {
  if (!FILE_EDIT_TOOLS.has(toolName)) return [];
  if (typeof params !== 'object' || params === null) return [];

  const p = params as Record<string, unknown>;
  const trackers: FileEditTracker[] = [];

  let filePath: string | undefined;
  if (typeof p['file_path'] === 'string') {
    filePath = p['file_path'];
  } else if (typeof p['path'] === 'string') {
    filePath = p['path'];
  } else if (typeof p['file'] === 'string') {
    filePath = p['file'];
  }

  trackers.push({
    callId,
    toolName,
    filePath,
    action: toolName,
  });

  return trackers;
}

function buildFileEditStartEvent(tracker: FileEditTracker, _params: unknown): FileEditEvent {
  return {
    type: 'file_edit_start',
    call_id: tracker.callId,
    tool_name: tracker.toolName,
    file_path: tracker.filePath,
    action: tracker.action,
  };
}

function buildFileEditEndEvent(tracker: FileEditTracker): FileEditEvent {
  return {
    type: 'file_edit_end',
    call_id: tracker.callId,
    tool_name: tracker.toolName,
    file_path: tracker.filePath,
    action: tracker.action,
  };
}

function buildFileEditErrorEvent(tracker: FileEditTracker, error: string): FileEditEvent {
  return {
    type: 'file_edit_error',
    call_id: tracker.callId,
    tool_name: tracker.toolName,
    file_path: tracker.filePath,
    action: tracker.action,
    error,
  };
}

function onProgressAcceptsFileEditEvents(
  _onProgress: (...args: unknown[]) => Promise<void>,
): boolean {
  return true;
}

async function invokeFileEditProgress(
  onProgress: (...args: unknown[]) => Promise<void>,
  events: FileEditEvent[],
): Promise<void> {
  try {
    await onProgress('', { file_edit_events: events });
  } catch (err) {
    logger.error({ err }, 'File edit progress callback error');
  }
}

export class FileEditActivityHook extends AgentHook {
  private _onProgress: ProgressCallback | null;
  private _workspace: string | null | undefined;
  private _trackersByCall: Map<string, FileEditTracker[]> = new Map();

  constructor(options: {
    onProgress?: ProgressCallback | null;
    workspace?: string | null;
  } = {}) {
    super();
    const onProgress = options.onProgress ?? null;
    this._onProgress = onProgress !== null && onProgressAcceptsFileEditEvents(onProgress as unknown as (...args: unknown[]) => Promise<void>)
      ? onProgress
      : null;
    this._workspace = options.workspace;
  }

  private _toolCallKey(toolCall: ToolCallRequest): string {
    const callId = toolCall.id || '';
    return callId ? `${callId}|${toolCall.name}` : `${toolCall.name}`;
  }

  async onTurnStart(_context: AgentHookContext): Promise<void> {
    this._trackersByCall.clear();
  }

  async onToolStart(
    context: AgentHookContext & { tool_name: string; tool_call_id: string; arguments?: unknown },
  ): Promise<void> {
    if (this._onProgress === null) return;
    const params = context.arguments;
    if (typeof params !== 'object' || params === null) return;

    const toolCall: ToolCallRequest = {
      id: context.tool_call_id,
      name: context.tool_name,
      arguments: params,
    };

    const trackers = prepareFileEditTrackers(
      toolCall.id,
      toolCall.name,
      params,
    );
    if (trackers.length === 0) return;

    this._trackersByCall.set(this._toolCallKey(toolCall), trackers);
    await this._emit(trackers.map(t => buildFileEditStartEvent(t, params)));
  }

  async onToolEnd(
    context: AgentHookContext & { tool_name: string; tool_call_id: string; result?: string },
  ): Promise<void> {
    const toolCall: ToolCallRequest = {
      id: context.tool_call_id,
      name: context.tool_name,
      arguments: undefined,
    };
    const key = this._toolCallKey(toolCall);
    const trackers = this._trackersByCall.get(key);
    if (trackers && trackers.length > 0) {
      await this._emit(trackers.map(t => buildFileEditEndEvent(t)));
      this._trackersByCall.delete(key);
    }
  }

  async onToolError(
    context: AgentHookContext & { tool_name: string; tool_call_id: string; error?: string },
  ): Promise<void> {
    const toolCall: ToolCallRequest = {
      id: context.tool_call_id,
      name: context.tool_name,
      arguments: undefined,
    };
    const key = this._toolCallKey(toolCall);
    const trackers = this._trackersByCall.get(key);
    if (trackers && trackers.length > 0) {
      await this._emit(
        trackers.map(t => buildFileEditErrorEvent(t, context.error || '')),
      );
      this._trackersByCall.delete(key);
    }
  }

  private async _emit(events: FileEditEvent[]): Promise<void> {
    if (this._onProgress !== null) {
      await invokeFileEditProgress(
        this._onProgress as unknown as (...args: unknown[]) => Promise<void>,
        events,
      );
    }
  }
}

export function createFileEditActivityHook(
  context: AgentTurnHookContext,
): AgentHook | null {
  if (context.onProgress === null) return null;
  return new FileEditActivityHook({
    onProgress: context.onProgress,
    workspace: context.workspace,
  });
}
