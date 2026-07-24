/**
 * Trace Collector — 从 Agent 事件中采集执行轨迹
 */

import type {
  TraceStep,
  ExecutionTrace,
  ToolIntent,
  ToolIntentMap,
  ResourceType,
} from './types';

/** 默认工具意图映射 */
const DEFAULT_TOOL_INTENTS: ToolIntentMap = {
  read_file: { intent: 'READ', resourceType: 'file' },
  list_directory: { intent: 'READ', resourceType: 'file' },
  edit_file: { intent: 'MODIFY', resourceType: 'file' },
  write_file: { intent: 'MODIFY', resourceType: 'file' },
  apply_patch: { intent: 'MODIFY', resourceType: 'file' },
  delete_file: { intent: 'MODIFY', resourceType: 'file' },
  rename_file: { intent: 'MODIFY', resourceType: 'file' },
  create_directory: { intent: 'MODIFY', resourceType: 'file' },
  remove_directory: { intent: 'MODIFY', resourceType: 'file' },
  grep: { intent: 'READ', resourceType: 'file' },
  search_codebase: { intent: 'READ', resourceType: 'file' },
  find_files: { intent: 'READ', resourceType: 'file' },
  shell: { intent: 'VERIFY', resourceType: 'other' },
  web_search: { intent: 'RESEARCH', resourceType: 'api' },
  web_fetch: { intent: 'RESEARCH', resourceType: 'api' },
  memory_read: { intent: 'MEMORY', resourceType: 'memory' },
  memory_write: { intent: 'MEMORY', resourceType: 'memory' },
  memory_search: { intent: 'MEMORY', resourceType: 'memory' },
  cron_create: { intent: 'SCHEDULE', resourceType: 'other' },
  cron_list: { intent: 'SCHEDULE', resourceType: 'other' },
  cron_delete: { intent: 'SCHEDULE', resourceType: 'other' },
};

/** 简单的规范化哈希 (用于 fingerprint) */
export function simpleHash(input: string): string {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) - h + input.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

/** 从工具参数中提取资源 ID（文件路径 / URL 等） */
function extractResourceId(toolName: string, args: Record<string, unknown>): string | undefined {
  if (!args || typeof args !== 'object') return undefined;

  // 文件工具
  if ('file_path' in args) return String(args.file_path);
  if ('path' in args) return String(args.path);

  // Web 工具
  if ('url' in args) return String(args.url);
  if ('query' in args) return String(args.query);

  // Shell
  if ('command' in args) return `shell:${simpleHash(String(args.command)).slice(0, 8)}`;

  // Memory
  if ('key' in args) return String(args.key);

  // Search
  if ('pattern' in args) return String(args.pattern);

  return undefined;
}

/** 从错误信息生成指纹 */
export function errorFingerprint(error: string): string {
  // 规范化：移除行号、时间戳、地址等噪声
  const normalized = error
    .replace(/\d+:\d+/g, 'N:N')         // 行号 line:col
    .replace(/0x[0-9a-f]+/gi, '0xADDR') // 内存地址
    .replace(/\d{4,}/g, 'NUM')          // 大数字
    .replace(/\/[\w./-]+\.\w+/g, '/PATH') // 文件路径
    .trim()
    .slice(0, 200);                       // 截断
  return simpleHash(normalized);
}

export class TraceCollector {
  private trace: ExecutionTrace;
  private toolIntents: ToolIntentMap;
  private currentTurnIndex = 0;
  private stepCounter = 0;

  constructor(windowSize: number, toolIntents?: ToolIntentMap) {
    this.trace = {
      steps: [],
      windowSize,
      totalSteps: 0,
    };
    this.toolIntents = { ...DEFAULT_TOOL_INTENTS, ...toolIntents };
  }

  /** 获取当前执行轨迹 */
  getTrace(): ExecutionTrace {
    return this.trace;
  }

  /** 获取最近的 N 步 */
  getRecentSteps(n: number): TraceStep[] {
    return this.trace.steps.slice(-n);
  }

  /** 开始新 turn */
  startTurn(): void {
    this.currentTurnIndex++;
  }

  /** 记录助手文本输出 */
  recordAssistantOutput(text: string, tokensUsed?: number): void {
    const step = this.createStep('assistant');
    step.textOutput = text;
    step.textLength = text.length;
    step.tokensUsed = tokensUsed;
    step.success = true;
    this.addStep(step);
  }

  /** 记录工具调用 */
  recordToolCall(
    toolName: string,
    args: Record<string, unknown>,
    result: { success: boolean; output?: string; error?: string; tokensUsed?: number },
    stateBefore: string,
    stateAfter: string,
  ): void {
    const step = this.createStep('tool_call');
    step.toolName = toolName;

    // 查找意图映射
    const mapping = this.toolIntents[toolName];
    if (mapping) {
      step.toolIntent = mapping.intent;
      step.resourceType = mapping.resourceType;
    } else {
      step.toolIntent = 'OTHER';
      step.resourceType = 'other';
    }

    // 提取资源 ID
    step.resourceId = extractResourceId(toolName, args);
    step.targetKey = step.resourceId;

    // 参数哈希（规范化）
    const inputStr = JSON.stringify(args, Object.keys(args).sort());
    step.inputHash = simpleHash(inputStr);

    // 输出哈希
    if (result.output) {
      step.outputHash = simpleHash(result.output.slice(0, 500));
    }

    // 状态
    step.stateBefore = stateBefore;
    step.stateAfter = stateAfter;
    step.stateChanged = stateBefore !== stateAfter;
    step.success = result.success;

    // 错误
    if (!result.success && result.error) {
      step.errorHash = errorFingerprint(result.error);
      step.errorType = this.classifyError(result.error);
    }

    step.tokensUsed = result.tokensUsed;
    this.addStep(step);
  }

  private createStep(type: TraceStep['type']): TraceStep {
    return {
      id: ++this.stepCounter,
      turnIndex: this.currentTurnIndex,
      type,
      success: false,
      stateBefore: '',
      stateAfter: '',
      stateChanged: false,
      timestamp: Date.now(),
      durationMs: 0,
    };
  }

  private addStep(step: TraceStep): void {
    this.trace.steps.push(step);
    this.trace.totalSteps++;

    // 滑窗裁剪
    if (this.trace.steps.length > this.trace.windowSize) {
      this.trace.steps = this.trace.steps.slice(-this.trace.windowSize);
    }
  }

  private classifyError(error: string): string {
    const lower = error.toLowerCase();
    if (lower.includes('permission') || lower.includes('eacces')) return 'permission';
    if (lower.includes('not found') || lower.includes('enoent')) return 'not_found';
    if (lower.includes('timeout') || lower.includes('etimedout')) return 'timeout';
    if (lower.includes('rate limit') || lower.includes('429')) return 'rate_limit';
    if (lower.includes('syntax') || lower.includes('parse')) return 'syntax';
    if (lower.includes('type') && lower.includes('error')) return 'type_error';
    if (lower.includes('network') || lower.includes('econnrefused')) return 'network';
    return 'unknown';
  }

  /** 重置 */
  reset(): void {
    this.trace.steps = [];
    this.trace.totalSteps = 0;
    this.currentTurnIndex = 0;
    this.stepCounter = 0;
  }

  /** 获取当前 turn index */
  get turnIndex(): number {
    return this.currentTurnIndex;
  }

  /** 获取总步数 */
  get totalSteps(): number {
    return this.trace.totalSteps;
  }
}
