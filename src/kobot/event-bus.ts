import type { AgentEvent, RunResult } from '../agent/types';
import type { AssistantMessage, TextContent } from '../ai/types';

// ─── Kobot 层业务事件 ───────────────────────────────────────────────
// 流事件统一使用 src/agent/types.ts 的 AgentEvent 体系，
// 此处仅补充 Kobot 层独有的业务事件（运行生命周期与文件编辑）

export interface RunStartedEvent {
  type: 'run_started';
  metadata: Record<string, unknown>;
}

export interface RunFinishedEvent {
  type: 'run_finished';
  content?: string;
  result: RunResult;
}

export interface RunFailedEvent {
  type: 'run_failed';
  content?: string;
  error: string;
  result?: RunResult;
}

export interface FileEditEventData {
  edit_type: 'start' | 'end' | 'error';
  call_id: string;
  tool_name: string;
  file_path?: string;
  action?: string;
  error?: string;
}

export interface FileEditEvent {
  type: 'file_edit';
  file_edit: FileEditEventData;
}

export type KobotEvent =
  | AgentEvent
  | RunStartedEvent
  | RunFinishedEvent
  | RunFailedEvent
  | FileEditEvent;

// ─── 常量与工具 ─────────────────────────────────────────────────────

export const FILE_EDIT_TOOLS = new Set([
  'write_file',
  'edit_file',
  'apply_patch',
  'delete_file',
  'rename_file',
  'create_directory',
  'remove_directory',
]);

export function extractTextContent(content: AssistantMessage['content']): string {
  return content
    .filter((c): c is TextContent => c.type === 'text')
    .map(c => c.text)
    .join('');
}
