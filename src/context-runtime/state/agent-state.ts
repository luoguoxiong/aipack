/**
 * Agent State - 核心状态模型和格式化工具
 *
 * 提供 Agent 状态的创建、格式化、提取等功能
 */

import type { AgentMessage } from '../../agent';
import type {
  AgentState,
  FileState,
  WorkspaceState,
  TaskPhase,
  ErrorState,
  Constraint,
  Decision,
  WorkspaceObserverState,
} from '../types';
import { getMessageContent } from './message-adapter';

/**
 * 从助手消息中提取工具调用列表
 * 支持 content 数组格式（type: "toolCall"）
 * 同时兼容旧格式（toolCalls / tool_calls / functionCall 字段）
 */
function extractToolCallsFromAssistant(msg: AgentMessage): Array<{ id: string; name?: string }> {
  const calls: Array<{ id: string; name?: string }> = [];

  // content 数组格式：工具调用在 content 数组中，type 为 "toolCall"
  if ('content' in msg && Array.isArray((msg as any).content)) {
    for (const block of (msg as any).content) {
      if (block.type === 'toolCall' && block.id) {
        calls.push({ id: block.id, name: block.name });
      }
    }
  }

  // 兼容旧格式：toolCalls / tool_calls 字段
  if (calls.length === 0) {
    const toolCalls = (msg as any).toolCalls || (msg as any).tool_calls;
    if (toolCalls && Array.isArray(toolCalls)) {
      for (const tc of toolCalls) {
        if (tc.id) {
          calls.push({ id: tc.id, name: tc.name || tc.function?.name });
        }
      }
    }
  }

  // 兼容 functionCall 格式
  if (calls.length === 0) {
    const functionCall = (msg as any).functionCall || (msg as any).function_call;
    if (functionCall?.id) {
      calls.push({ id: functionCall.id, name: functionCall.name });
    }
  }

  return calls;
}

/**
 * 创建初始 Agent 状态
 * 返回一个全新的、空的 AgentState 对象
 */
export function createInitialState(): AgentState {
  return {
    task: {
      goal: '',
      phase: 'requirement_analysis',
      status: 'running',
      startTime: Date.now(),
      elapsedMs: 0,
    },
    completedTasks: [],
    nextActions: [],
    attemptedStrategies: [],
    constraints: [],
    decisions: [],
    workspace: {
      modifiedFiles: [],
      createdFiles: [],
      deletedFiles: [],
      gitStatus: {
        branch: 'unknown',
        ahead: 0,
        behind: 0,
        staged: [],
        unstaged: [],
        untracked: [],
      },
      gitDiffSummary: '',
      testStatus: {},
    },
    errors: [],
    failedAttempts: [],
    metadata: {
      snapshotVersion: 1,
      lastUpdated: Date.now(),
      compressionCount: 0,
    },
  };
}

/**
 * 将 AgentState 格式化为人类可读的快照文本
 * 用于生成状态快照消息，让模型了解当前状态
 */
export function formatStateSnapshot(state: AgentState): string {
  const lines: string[] = [];
  const width = 50;
  const border = '═'.repeat(width);

  lines.push(border);
  lines.push(`═══ Agent State Snapshot (v${state.metadata.snapshotVersion}) ═══`);
  lines.push('');

  // 任务信息
  lines.push(`【当前目标】${state.task.goal || '(未设置)'}`);
  lines.push(`【当前阶段】${state.task.phase}`);
  lines.push(`【状态】${state.task.status}`);
  lines.push('');

  // 已完成任务
  if (state.completedTasks.length > 0) {
    lines.push('【已完成】');
    for (const task of state.completedTasks.slice(-10)) {
      lines.push(`- ${task}`);
    }
    lines.push('');
  }

  // 已修改文件
  if (state.workspace.modifiedFiles.length > 0) {
    lines.push('【已修改文件】');
    for (const f of state.workspace.modifiedFiles) {
      const diffInfo = f.diffSummary ? ` (${f.diffSummary})` : '';
      lines.push(`- ${f.path} (${f.status})${diffInfo}`);
    }
    lines.push('');
  }

  // Git 状态
  if (state.workspace.gitStatus.branch !== 'unknown') {
    const gs = state.workspace.gitStatus;
    const branchInfo = `${gs.branch}${gs.ahead > 0 ? ` (↑${gs.ahead})` : ''}${gs.behind > 0 ? ` (↓${gs.behind})` : ''}`;
    lines.push(`【Git 分支】${branchInfo}`);
    if (gs.staged.length > 0 || gs.unstaged.length > 0) {
      lines.push(`  - 已暂存: ${gs.staged.length} 个文件`);
      lines.push(`  - 未暂存: ${gs.unstaged.length} 个文件`);
    }
    if (state.workspace.gitDiffSummary) {
      lines.push(`【变更统计】${state.workspace.gitDiffSummary.split('\n').pop() || ''}`);
    }
    lines.push('');
  }

  // 当前问题/错误
  const activeErrors = state.errors.filter(e => !e.resolved);
  if (activeErrors.length > 0) {
    lines.push('【当前问题】');
    for (const err of activeErrors.slice(-3)) {
      lines.push(`${err.error}`);
      if (err.occurrenceCount > 1) {
        lines.push(`  (已出现 ${err.occurrenceCount} 次，来源: ${err.source})`);
      } else {
        lines.push(`  (来源: ${err.source})`);
      }
    }
    lines.push('');
  }

  // 测试状态
  if (state.workspace.testStatus.failed !== undefined) {
    const ts = state.workspace.testStatus;
    lines.push(`【测试状态】通过 ${ts.passed || 0}, 失败 ${ts.failed || 0}${ts.total ? ` (共 ${ts.total})` : ''}`);
    if (ts.failingTests && ts.failingTests.length > 0) {
      lines.push(`  失败用例: ${ts.failingTests.slice(0, 3).join(', ')}`);
    }
    lines.push('');
  }

  // 失败尝试
  if (state.failedAttempts.length > 0) {
    lines.push(`【已尝试方法（${state.failedAttempts.length} 次）】`);
    for (let i = 0; i < Math.min(state.failedAttempts.length, 5); i++) {
      const attempt = state.failedAttempts[i];
      lines.push(`${i + 1}. ${attempt.action} → ${attempt.failureReason}`);
    }
    lines.push('');
  }

  // 关键约束
  const criticalConstraints = state.constraints.filter(c => c.priority === 'critical');
  if (criticalConstraints.length > 0) {
    lines.push('【关键约束】');
    for (const c of criticalConstraints) {
      lines.push(`- ${c.content}`);
    }
    lines.push('');
  }

  // 下一步
  if (state.nextActions.length > 0) {
    lines.push('【下一步】');
    for (const action of state.nextActions.slice(-3)) {
      lines.push(`- ${action}`);
    }
    lines.push('');
  }

  lines.push(border);
  return lines.join('\n');
}

/**
 * 从用户消息中提取目标
 * 查找最新的、看起来像目标的用户消息
 */
export function extractGoal(messages: AgentMessage[]): string {
  // 从后往前找最新的用户消息，看起来像目标的
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'user') {
      const content = getMessageContent(msg).trim();
      // 跳过非常短的消息或系统类消息
      if (content.length > 5 && !content.startsWith('[系统]')) {
        return content.slice(0, 500);
      }
    }
  }
  return '';
}

/**
 * 从消息中提取约束条件
 * 基于规则匹配用户消息中的约束模式
 */
export function extractConstraints(messages: AgentMessage[]): Constraint[] {
  const constraints: Constraint[] = [];
  const constraintPatterns = [
    { pattern: /不要|禁止|不能|不可以|must not|do not|don't/i, priority: 'critical' as const },
    { pattern: /必须|一定要|需要|should|must|need to/i, priority: 'high' as const },
    { pattern: /注意|小心|请注意|note|notice|be careful/i, priority: 'medium' as const },
  ];

  for (const msg of messages) {
    if (msg.role !== 'user') continue;
    const content = getMessageContent(msg);

    for (const { pattern, priority } of constraintPatterns) {
      const sentences = content.split(/[。！？.!?\n]/);
      for (const sentence of sentences) {
        if (pattern.test(sentence) && sentence.trim().length > 3 && sentence.trim().length < 200) {
          // 避免重复
          if (!constraints.some(c => c.content === sentence.trim())) {
            constraints.push({
              content: sentence.trim(),
              source: 'user',
              priority,
            });
          }
        }
      }
    }
  }

  return constraints;
}

/**
 * 从观察者状态更新工作区状态
 * 将 WorkspaceObserverState 同步到 AgentState.workspace
 */
export function updateWorkspaceFromObserver(
  state: AgentState,
  observerState: WorkspaceObserverState | null,
): void {
  if (!observerState || !observerState.git) return;

  const git = observerState.git;
  state.workspace.gitStatus = {
    branch: git.branch,
    ahead: git.ahead,
    behind: git.behind,
    staged: git.staged,
    unstaged: git.modified,
    untracked: git.untracked,
  };
  state.workspace.gitDiffSummary = git.diffSummary || '';

  // 更新修改文件列表
  const allModified = new Set([...git.modified, ...git.staged]);
  const currentFiles = new Map(state.workspace.modifiedFiles.map(f => [f.path, f]));

  // 添加新的/修改的文件
  for (const path of allModified) {
    if (!currentFiles.has(path)) {
      state.workspace.modifiedFiles.push({
        path,
        status: 'modified',
      });
    }
  }

  // 移除不再修改的文件（已干净）
  state.workspace.modifiedFiles = state.workspace.modifiedFiles.filter(
    f => allModified.has(f.path)
  );
}

/**
 * 从消息中检测当前任务阶段（P0 基于规则）
 * 根据最近消息中的工具调用类型来推断阶段
 */
export function detectPhase(messages: AgentMessage[]): TaskPhase {
  if (messages.length < 5) return 'requirement_analysis';

  const recent = messages.slice(-10);
  let reads = 0;
  let writes = 0;
  let tests = 0;
  let testFailures = 0;
  let edits = 0;

  for (const msg of recent) {
    // 工具结果消息角色为 'toolResult'
    // 助手消息可能包含工具调用
    let content = '';
    let toolName = '';

    if (msg.role === 'toolResult') {
      content = getMessageContent(msg);
      // 尝试从 toolCallId 或其他属性获取工具名
      toolName = (msg as any).toolName || (msg as any).name || '';
    } else if (msg.role === 'assistant') {
      // 检查助手消息中的工具调用
      const toolCalls = extractToolCallsFromAssistant(msg);
      if (toolCalls.length > 0) {
        toolName = toolCalls[0]?.name || '';
      }
      content = getMessageContent(msg);
    } else if (msg.role === 'bashExecution') {
      // Bash 执行消息
      content = getMessageContent(msg);
      toolName = 'shell';
    } else {
      continue;
    }

    // 统计读取操作
    if (toolName.includes('read') || toolName.includes('grep') || toolName.includes('search') || toolName.includes('glob')) {
      reads++;
    }
    // 统计写入/编辑操作
    if (toolName.includes('write') || toolName.includes('edit')) {
      writes++;
      edits++;
    }
    // 统计测试操作
    if (toolName.includes('test') || toolName.includes('shell') || content.includes('test') || content.includes('pytest') || content.includes('npm test') || content.includes('yarn test')) {
      tests++;
      if (content.includes('FAIL') || content.includes('failed') || content.includes('Error') || content.includes('✗')) {
        testFailures++;
      }
    }
  }

  // 调试阶段：测试失败 + 编辑
  if (testFailures > 1 && edits > 0) return 'debugging';
  // 验证阶段：主要运行测试/命令，没有编辑
  if (tests > 2 && edits === 0) return 'verification';
  // 实现阶段：大量写入
  if (writes > 2) return 'implementation';
  // 探索阶段：大量读取，少量写入
  if (reads > 4 && writes < 2) return 'exploration';
  // 重构阶段：大量编辑但测试通过
  if (edits > 4 && testFailures === 0 && tests > 0) return 'refactoring';

  return 'unknown';
}

/**
 * 跟踪错误（从工具结果中）
 * 记录错误并去重，统计出现次数
 */
export function trackError(
  state: AgentState,
  error: string,
  source: string,
  errorType = 'Unknown',
): void {
  const errorHash = hashString(`${errorType}:${error.slice(0, 200)}`);
  const existing = state.errors.find(e => hashString(`${e.errorType}:${e.error.slice(0, 200)}`) === errorHash);

  if (existing) {
    existing.occurrenceCount++;
    existing.resolved = false;
  } else {
    state.errors.push({
      error: error.slice(0, 500),
      errorType,
      source,
      resolved: false,
      firstSeen: Date.now(),
      occurrenceCount: 1,
    });
  }
}

/**
 * 将错误标记为已解决
 * @param source 可选，指定来源的错误才标记
 */
export function resolveErrors(state: AgentState, source?: string): void {
  if (source) {
    for (const e of state.errors) {
      if (e.source === source) {
        e.resolved = true;
      }
    }
  } else {
    // 如果看到后续成功，则将所有错误标记为已解决
    const recentSuccess = state.errors.some(e => !e.resolved) && state.completedTasks.length > 0;
    if (recentSuccess) {
      for (const e of state.errors) {
        e.resolved = true;
      }
    }
  }
}

/**
 * 添加一条失败尝试记录
 * 最多保留最近 10 条
 */
export function addFailedAttempt(
  state: AgentState,
  action: string,
  target: string,
  failureReason: string,
  errorType = 'Unknown',
): void {
  state.failedAttempts.push({
    action: action.slice(0, 200),
    target,
    failureReason: failureReason.slice(0, 200),
    errorType,
  });

  // 只保留最近 10 条
  if (state.failedAttempts.length > 10) {
    state.failedAttempts = state.failedAttempts.slice(-10);
  }
}

/**
 * 添加一个已完成的任务
 * 自动去重
 */
export function addCompletedTask(state: AgentState, task: string): void {
  if (!state.completedTasks.includes(task)) {
    state.completedTasks.push(task);
  }
}

/**
 * 添加一个决策记录
 */
export function addDecision(state: AgentState, decision: string, reason: string): void {
  state.decisions.push({
    decision,
    reason,
    timestamp: Date.now(),
  });
}

/**
 * 简单的字符串哈希函数
 * 用于错误去重等场景
 */
function hashString(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}
