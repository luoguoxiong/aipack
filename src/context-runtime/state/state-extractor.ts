/**
 * 状态提取器 - 从消息和工作区中确定性地提取 AgentState
 *
 * 负责从对话历史、工具结果、工作区状态等多源信息中，
 * 提取和更新 Agent 的心智状态。
 */

import type { AgentMessage } from '../../agent/types';
import type { WorkspaceObserver } from '../observer';
import type { AgentState, WorkspaceObserverState, ToolDigest } from '../types';
import {
  createInitialState,
  extractGoal,
  extractConstraints,
  detectPhase,
  updateWorkspaceFromObserver,
  addCompletedTask,
  trackError,
} from './agent-state';

/** 工具结果信息 */
export interface ToolResultInfo {
  toolName: string;  // 工具名称
  success: boolean;  // 是否成功
  output?: string;   // 输出内容
  error?: string;    // 错误信息
  files?: { path: string; action: 'read' | 'write' | 'edit' | 'delete' }[];  // 涉及的文件
}

/**
 * 状态提取器类
 * 从消息和工作区中提取和维护 AgentState
 */
export class StateExtractor {
  private state: AgentState;                    // 当前状态
  private lastToolResults: ToolResultInfo[] = [];  // 最近的工具结果

  constructor() {
    this.state = createInitialState();
  }

  /**
   * 获取当前状态
   */
  getState(): AgentState {
    return this.state;
  }

  /**
   * 重置状态（新会话）
   */
  reset(): void {
    this.state = createInitialState();
    this.lastToolResults = [];
  }

  /**
   * 增加压缩计数
   * 每次压缩后调用，更新版本号和压缩次数
   */
  incrementCompressionCount(): void {
    this.state.metadata.compressionCount++;
    this.state.metadata.snapshotVersion++;
    this.state.metadata.lastUpdated = Date.now();
  }

  /**
   * 从消息和工作区中提取/更新状态
   *
   * @param messages 当前消息列表
   * @param observer 工作区观察者（可选）
   * @param recentToolResults 最近的工具结果
   * @returns 更新后的 AgentState
   */
  async extract(
    messages: AgentMessage[],
    observer: WorkspaceObserver | null,
    recentToolResults: ToolResultInfo[] = [],
  ): Promise<AgentState> {
    // 1. 提取目标
    const goal = extractGoal(messages);
    if (goal) {
      this.state.task.goal = goal;
    }

    // 2. 更新阶段
    this.state.task.phase = detectPhase(messages);

    // 3. 提取约束
    const constraints = extractConstraints(messages);
    // 合并约束（保留关键的，添加新的）
    const existingConstraintContents = new Set(this.state.constraints.map(c => c.content));
    for (const c of constraints) {
      if (!existingConstraintContents.has(c.content)) {
        this.state.constraints.push(c);
      }
    }

    // 4. 处理工具结果
    for (const result of recentToolResults) {
      this.processToolResult(result);
    }

    // 5. 从工作区观察者更新（真实数据）
    if (observer) {
      const wsState = await observer.getFreshState();
      updateWorkspaceFromObserver(this.state, wsState);
    }

    // 6. 更新已耗时间
    this.state.task.elapsedMs = Date.now() - this.state.task.startTime;

    // 7. 检查阻塞状态
    const unresolvedErrors = this.state.errors.filter(e => !e.resolved);
    if (unresolvedErrors.length > 2 && this.state.failedAttempts.length >= 3) {
      this.state.task.status = 'blocked';
    } else if (this.state.task.status === 'blocked' && unresolvedErrors.length === 0) {
      this.state.task.status = 'running';
    }

    this.state.metadata.lastUpdated = Date.now();
    return this.state;
  }

  /**
   * 处理单个工具结果，更新状态
   */
  private processToolResult(result: ToolResultInfo): void {
    const { toolName, success, output, error, files } = result;

    if (success) {
      // 跟踪文件变更
      if (files) {
        for (const f of files) {
          if (f.action === 'write' || f.action === 'edit') {
            // 标记任务有进展
            const taskDesc = `${f.action === 'write' ? '创建' : '修改'}文件 ${f.path}`;
            addCompletedTask(this.state, taskDesc);
          }
        }
      }

      // 检查是否看起来像测试输出
      if (output && (toolName.includes('test') || output.includes('passed') || output.includes('PASSED') || output.includes('test result'))) {
        const testStatus = this.parseTestOutput(output);
        if (testStatus) {
          this.state.workspace.testStatus = {
            ...this.state.workspace.testStatus,
            ...testStatus,
            lastRun: Date.now(),
          };
          if (testStatus.failed === 0) {
            // 所有测试通过，标记相关错误为已解决
            for (const e of this.state.errors) {
              if (e.errorType.includes('Test') || e.source.includes('test')) {
                e.resolved = true;
              }
            }
          }
        }
      }
    } else if (error) {
      // 跟踪错误
      const errorType = this.categorizeError(error, toolName);
      trackError(this.state, error, toolName, errorType);
    }
  }

  /**
   * 解析测试输出，提取测试统计
   */
  private parseTestOutput(output: string): { passed?: number; failed?: number; total?: number; failingTests?: string[] } | null {
    const result: { passed?: number; failed?: number; total?: number; failingTests?: string[] } = {};
    
    // 匹配常见的测试输出模式
    // 模式："X passed, Y failed"
    const passedMatch = output.match(/(\d+)\s*(?:passed|Passed|ok|PASS)/);
    const failedMatch = output.match(/(\d+)\s*(?:failed|Failed|FAIL|error)/);
    const totalMatch = output.match(/(?:of|from|共)\s*(\d+)/) || output.match(/(\d+)\s*(?:tests|test\s*suites)/i);
    
    if (passedMatch) result.passed = parseInt(passedMatch[1], 10);
    if (failedMatch) result.failed = parseInt(failedMatch[1], 10);
    if (totalMatch) result.total = parseInt(totalMatch[1], 10);
    
    // 提取失败的测试名
    const failingTests: string[] = [];
    const failLines = output.split('\n').filter(l => l.includes('FAIL') || l.includes('✗') || l.includes('×'));
    for (const line of failLines.slice(0, 5)) {
      const match = line.match(/(?:FAIL|✗|×)\s*[─-]?\s*(.+?)(?:\s|$)/);
      if (match && match[1] && match[1].length > 2 && match[1].length < 100) {
        failingTests.push(match[1].trim());
      }
    }
    if (failingTests.length > 0) {
      result.failingTests = failingTests;
    }

    if (result.passed !== undefined || result.failed !== undefined) {
      return result;
    }
    return null;
  }

  /**
   * 对错误进行分类
   */
  private categorizeError(error: string, toolName: string): string {
    if (error.includes('ENOENT') || error.includes('not found') || error.includes('No such file')) {
      return 'FileNotFound';
    }
    if (error.includes('EACCES') || error.includes('permission denied') || error.includes('Permission denied')) {
      return 'PermissionDenied';
    }
    if (error.includes('SyntaxError') || error.includes('syntax error')) {
      return 'SyntaxError';
    }
    if (error.includes('TypeError') || error.includes('undefined') || error.includes('null')) {
      return 'TypeError';
    }
    if (error.includes('AssertionError') || error.includes('assert') || error.includes('expected')) {
      return 'TestFailure';
    }
    if (error.includes('timeout') || error.includes('ETIMEDOUT')) {
      return 'Timeout';
    }
    if (toolName.includes('test') || toolName.includes('shell')) {
      return 'CommandFailed';
    }
    return 'ToolError';
  }
}
