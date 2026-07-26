/**
 * 工作区观察者 - 基于 Git 的真实状态源
 *
 * 功能：
 * - 通过 Git 状态获取工作区的真实变更情况
 * - 提供防抖检查（避免频繁调用 git）
 * - 支持工具结果推断作为 fallback（当 Git 不可用时）
 *
 * 设计思路：
 * Git 状态是最可靠的"地面真相"，比从工具结果推断更准确。
 * 优先使用 Git，不可用时降级到工具推断。
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { logger } from '../../utils/logger';
import type { WorkspaceObserverConfig, WorkspaceObserverState } from '../types';

const execFileAsync = promisify(execFile);

/**
 * 工作区观察者类
 * 监控工作区的文件系统和 Git 状态变化
 */
export class WorkspaceObserver {
  private config: WorkspaceObserverConfig;     // 配置
  private workspacePath: string;                // 工作区路径
  private state: WorkspaceObserverState | null = null;  // 缓存的状态
  private lastCheckTime = 0;                    // 上次检查时间
  private debounceTimer: NodeJS.Timeout | null = null;  // 防抖定时器
  private pendingCheck = false;                 // 是否有待执行的检查

  constructor(workspacePath: string, config: WorkspaceObserverConfig) {
    this.workspacePath = workspacePath;
    this.config = config;
  }

  /**
   * 调度一次防抖检查（工具调用后触发）
   * 避免每次工具调用都立即执行 git 命令
   */
  scheduleCheck(): void {
    if (!this.config.enabled) return;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.pendingCheck = true;
    this.debounceTimer = setTimeout(() => {
      this.check().catch(() => {});
    }, this.config.debounceMs);
  }

  /**
   * 检查状态是否过期，如果过期则刷新
   * 用于在读取状态前确保数据不太旧
   */
  async checkIfStale(): Promise<void> {
    if (!this.config.enabled) return;
    const now = Date.now();
    if (now - this.lastCheckTime > this.config.checkIntervalMs) {
      await this.check();
    }
  }

  /**
   * 强制立即检查工作区状态
   *
   * @returns 最新的工作区状态，失败时返回缓存的状态
   */
  async check(): Promise<WorkspaceObserverState | null> {
    if (!this.config.enabled) return this.state;

    try {
      // 并行获取 Git 状态和文件系统状态
      const gitState = this.config.useGit ? await this.getGitState() : null;
      const fsState = await this.getFilesystemState();

      let source: WorkspaceObserverState['source'] = 'tool_inference';
      let result: Partial<WorkspaceObserverState> = {
        filesystem: fsState,
      };

      if (gitState) {
        // 有 Git 状态，使用 Git 作为真相源
        result.git = gitState;
        source = 'git_status';
      } else if (this.config.fallbackToToolInference) {
        // Git 不可用，降级到工具推断
        result.git = this.createEmptyGitState();
        source = 'tool_inference';
      } else {
        // 既没有 Git 也不允许降级，返回缓存状态
        return this.state;
      }

      this.state = {
        ...result,
        lastChecked: Date.now(),
        source,
      } as WorkspaceObserverState;

      this.lastCheckTime = Date.now();
      this.pendingCheck = false;
      return this.state;
    } catch (err) {
      logger.debug({ err }, '工作区观察者检查失败');
      if (this.config.fallbackToToolInference) {
        this.state = this.createFallbackState();
        return this.state;
      }
      return this.state;
    }
  }

  /**
   * 获取当前状态（不触发检查）
   */
  getState(): WorkspaceObserverState | null {
    return this.state;
  }

  /**
   * 获取当前状态，先检查是否过期
   */
  async getFreshState(): Promise<WorkspaceObserverState | null> {
    await this.checkIfStale();
    return this.state;
  }

  /**
   * 获取 Git 状态
   * 包括：分支、变更文件、暂存区、未跟踪文件、ahead/behind 等
   */
  private async getGitState(): Promise<WorkspaceObserverState['git'] | null> {
    try {
      // 检查是否是 Git 仓库
      const { stdout: revParse } = await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], {
        cwd: this.workspacePath,
        timeout: 5000,
      });

      if (revParse.trim() !== 'true') {
        return null;
      }

      // 获取状态（v2 格式，便于解析）
      const { stdout: status } = await execFileAsync('git', ['status', '--porcelain=v2', '--branch'], {
        cwd: this.workspacePath,
        timeout: 5000,
      });

      const lines = status.trim().split('\n').filter(Boolean);
      
      // 解析分支信息
      const branchLine = lines.find(l => l.startsWith('# branch.'));
      const branch = branchLine ? branchLine.replace('# branch.oid ', '').replace('# branch.head ', '').split(' ').pop() || 'unknown' : 'unknown';
      
      // 解析 ahead/behind
      let ahead = 0;
      let behind = 0;
      const abLine = lines.find(l => l.startsWith('# branch.ab'));
      if (abLine) {
        const aheadMatch = abLine.match(/\+(\d+)/);
        const behindMatch = abLine.match(/-(\d+)/);
        if (aheadMatch) ahead = parseInt(aheadMatch[1], 10);
        if (behindMatch) behind = parseInt(behindMatch[1], 10);
      }

      // 解析文件状态
      const modified: string[] = [];   // 工作区修改
      const staged: string[] = [];     // 已暂存
      const untracked: string[] = [];  // 未跟踪

      for (const line of lines) {
        if (line.startsWith('#')) continue;
        if (line.startsWith('?')) {
          untracked.push(line.slice(2).trim());
        } else {
          const parts = line.split(' ');
          const indexStatus = parts[0]?.[0];    // 暂存区状态
          const workTreeStatus = parts[0]?.[1]; // 工作区状态
          const path = parts.slice(-1)[0];
          
          if (indexStatus !== '.' && indexStatus !== '?') {
            staged.push(path);
          }
          if (workTreeStatus !== '.' && workTreeStatus !== '?') {
            modified.push(path);
          }
        }
      }

      // 获取 diff 统计摘要
      let diffSummary = '';
      try {
        const { stdout: diffStat } = await execFileAsync('git', ['diff', '--stat'], {
          cwd: this.workspacePath,
          timeout: 5000,
        });
        diffSummary = diffStat.trim();
      } catch {
        // 没有变更时 diff --stat 可能失败
      }

      // 获取最后一次提交
      let lastCommit: string | undefined;
      try {
        const { stdout: log } = await execFileAsync('git', ['log', '-1', '--oneline'], {
          cwd: this.workspacePath,
          timeout: 5000,
        });
        lastCommit = log.trim();
      } catch {
        // 忽略
      }

      return {
        branch,
        status: modified.length > 0 || staged.length > 0 || untracked.length > 0 ? 'dirty' : 'clean',
        modified,
        staged,
        untracked,
        ahead,
        behind,
        lastCommit,
        diffSummary,
      };
    } catch (err) {
      logger.debug({ err }, 'Git 状态获取失败');
      return null;
    }
  }

  /**
   * 获取文件系统状态
   * P0：简单实现，基于 Git 信息
   * P2：将使用 fs.watch 实时监控
   */
  private async getFilesystemState(): Promise<WorkspaceObserverState['filesystem']> {
    return {
      recentlyModified: [],
      recentlyCreated: [],
      recentlyDeleted: [],
    };
  }

  /**
   * 创建空的 Git 状态（用于 fallback）
   */
  private createEmptyGitState(): WorkspaceObserverState['git'] {
    return {
      branch: 'unknown',
      status: 'clean',
      modified: [],
      staged: [],
      untracked: [],
      ahead: 0,
      behind: 0,
      diffSummary: '',
    };
  }

  /**
   * 创建 fallback 状态（当 Git 完全不可用时）
   */
  private createFallbackState(): WorkspaceObserverState {
    return {
      git: this.createEmptyGitState(),
      filesystem: {
        recentlyModified: [],
        recentlyCreated: [],
        recentlyDeleted: [],
      },
      lastChecked: Date.now(),
      source: 'tool_inference',
    };
  }

  /**
   * 从工具结果更新状态（当 Git 不可用时使用）
   * 根据工具调用的结果推断文件变更
   *
   * @param toolName 工具名
   * @param result 工具结果
   * @param files 涉及的文件列表
   */
  updateFromToolResult(
    toolName: string,
    result: { success: boolean; output?: string; error?: string },
    files?: { path: string; action: 'read' | 'write' | 'edit' | 'delete' }[],
  ): void {
    if (!this.state) {
      this.state = this.createFallbackState();
    }

    if (files && result.success) {
      for (const f of files) {
        if (f.action === 'write' || f.action === 'edit') {
          // 写入/编辑 → 添加到修改列表
          if (!this.state.git.modified.includes(f.path)) {
            this.state.git.modified.push(f.path);
          }
          this.state.git.status = 'dirty';
        } else if (f.action === 'delete') {
          // 删除 → 从修改列表移除
          const idx = this.state.git.modified.indexOf(f.path);
          if (idx >= 0) this.state.git.modified.splice(idx, 1);
        }
      }
    }
  }
}
