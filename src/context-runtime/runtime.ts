/**
 * Agent Context Runtime (ACR) - 主入口文件
 * Agent 上下文操作系统
 *
 * 管理完整的上下文生命周期：
 * 观察 → 理解 → 压缩 → 记忆 → 重建 → 继续
 */

import { logger } from '../utils/logger';
import type { AgentHook, AgentHookContext, AgentRunHookContext, AgentToolHookContext } from '../agent/types';
import type { AgentMessage } from '../agent/types';
import type {
  ACRConfig,
  CompactOptions,
  CompressionResult,
  CompressionLevel,
  HealthLevel,
  HealthSnapshot,
  ACREvent,
  ToolDigest,
  ContextEntropy,
} from './types';
import { DEFAULT_CONFIG, getProfileConfig, mergeConfig } from './config/defaults';
import { TokenMonitor, DensityMonitor } from './monitor';
import { WorkspaceObserver } from './observer';
import { StateExtractor, type ToolResultInfo, createInitialState, formatStateSnapshot } from './state';
import { SnapshotBuilder } from './state/snapshot-builder';
import { ToolDigestor } from './tool';
import { runL1Clean, runL2Window, runL3Collapse, runL4Snapshot, runL5Emergency, ensureToolPairing, countOrphanedPairs, createTransitionMessage } from './compress';
import { SessionMemoryStore } from './memory';
import { Metrics } from './observability';
import {
  createStateSnapshotMessage,
  getMessageContent,
  findStateSnapshotIndex,
  removeStateSnapshots,
  removeToolDigests,
  setMessageContent,
  estimateMessageTokens,
  isStateSnapshot,
} from './state/message-adapter';

/** AgentContextRuntime 构造函数选项 */
export interface AgentContextRuntimeOptions {
  workspacePath?: string;   // 工作区路径
  config?: Partial<ACRConfig>;  // 配置覆盖
  systemPrompt?: string;    // 系统提示词
}

/** ACR 事件监听器类型 */
export type ACREventListener = (event: ACREvent) => void;

/**
 * Agent 上下文运行时主类
 * 实现 AgentHook 接口，可以挂载到 Agent 上自动运行
 *
 * 核心职责：
 * 1. 监控上下文健康状态（token、价值密度）
 * 2. 在需要时自动触发压缩
 * 3. 管理 AgentState 状态提取和更新
 * 4. 管理记忆写入和读取
 * 5. 提供可观测性指标
 */
export class AgentContextRuntime implements AgentHook {
  private config: ACRConfig;           // 运行时配置
  private workspacePath: string;       // 工作区路径
  private systemPrompt: string;        // 系统提示词

  // ─── 核心组件 ───
  private tokenMonitor: TokenMonitor;       // Token 监控器
  private densityMonitor: DensityMonitor;   // 价值密度监控器
  private workspaceObserver: WorkspaceObserver;  // 工作区观察者
  private stateExtractor: StateExtractor;   // 状态提取器
  private snapshotBuilder: SnapshotBuilder; // 快照构建器
  private toolDigestor: ToolDigestor;       // 工具摘要器
  private sessionMemory: SessionMemoryStore;  // 会话记忆存储
  private metrics: Metrics;                 // 指标收集器

  // ─── 内部状态 ───
  private currentMessages: AgentMessage[] = [];  // 当前消息列表
  private recentToolResults: ToolResultInfo[] = [];  // 最近的工具结果
  private toolDigests: ToolDigest[] = [];    // 工具摘要列表
  private currentTurn = 0;                   // 当前回合数
  private lastCompressionTurn = -100;        // 上次压缩的回合（用于冷却跟踪）
  // 各压缩级别上次运行的回合数
  private cooldownLevelLastRun: Record<CompressionLevel, number> = {
    clean: -100,
    window: -100,
    collapse: -100,
    snapshot: -100,
    emergency: -100,
  };
  private compressionCount = 0;           // 压缩次数计数
  private eventListeners: ACREventListener[] = [];  // 事件监听器列表
  private attached = false;                // 是否已挂载到 Agent

  constructor(options: AgentContextRuntimeOptions = {}) {
    this.workspacePath = options.workspacePath || process.cwd();
    this.systemPrompt = options.systemPrompt || '';

    // 合并配置：默认配置 → 场景配置 → 用户覆盖
    const baseConfig = { ...DEFAULT_CONFIG };
    const profileConfig = options.config?.profile ? getProfileConfig(options.config.profile) : {};
    this.config = mergeConfig(mergeConfig(baseConfig, profileConfig), options.config || {});

    // 初始化各核心组件
    this.tokenMonitor = new TokenMonitor(this.config.contextLimit, this.config.monitors.token);
    this.densityMonitor = new DensityMonitor(this.config.contextLimit, this.config.monitors.valueDensity);
    this.workspaceObserver = new WorkspaceObserver(this.workspacePath, this.config.monitors.workspaceObserver);
    this.stateExtractor = new StateExtractor();
    this.snapshotBuilder = new SnapshotBuilder();
    this.toolDigestor = new ToolDigestor(this.config.compression.toolDigest);
    this.sessionMemory = new SessionMemoryStore();
    this.metrics = new Metrics(this.config.observability.keepCompressionHistory);

    // 初始化会话记忆
    this.sessionMemory.init(createInitialState());

    logger.debug({
      profile: this.config.profile,
      contextLimit: this.config.contextLimit,
      workspacePath: this.workspacePath,
    }, 'ACR 已初始化');
  }

  // ─── 公共 API ───

  /**
   * 挂载到 Agent（由 Agent 调用）
   */
  attach(agent?: { steer?: (msg: string) => void }): void {
    this.attached = true;
    this.emit({ type: 'health_check', timestamp: Date.now() });
  }

  /**
   * 注册事件监听器
   * @returns 取消监听的函数
   */
  on(listener: ACREventListener): () => void {
    this.eventListeners.push(listener);
    return () => {
      const idx = this.eventListeners.indexOf(listener);
      if (idx >= 0) this.eventListeners.splice(idx, 1);
    };
  }

  /**
   * 获取当前 Agent 状态
   */
  getState() {
    return this.stateExtractor.getState();
  }

  /**
   * 获取指标快照
   */
  getMetrics() {
    return this.metrics.snapshot();
  }

  /**
   * 获取健康状态快照
   * 综合 token、密度、熵等多维度健康信息
   */
  async getHealth(): Promise<HealthSnapshot> {
    const tokens = this.tokenMonitor.estimateTokens(this.currentMessages);
    const tokenHealth = this.tokenMonitor.check(tokens);
    const density = this.densityMonitor.check(this.currentMessages, tokens);
    const state = this.stateExtractor.getState();

    // 真实计算熵值
    const entropy = this.computeEntropy();

    // 综合健康等级：取最差的那个
    let overall: HealthLevel = tokenHealth.level;
    if (this.levelFromHealth(density.density < 0.4 ? 'warning' : 'ok') > this.levelFromHealth(overall)) {
      overall = density.density < 0.3 ? 'critical' : density.density < 0.4 ? 'warning' : overall;
    }
    if (entropy.isInLowValueExploration && this.levelFromHealth('warning') > this.levelFromHealth(overall)) {
      overall = 'warning';
    }

    return {
      token: tokenHealth,
      density,
      entropy,
      phase: state.task.phase,
      overall,
    };
  }

  /**
   * 计算上下文熵（真实值）
   * 基于最近的消息统计各种指标
   */
  private computeEntropy(): ContextEntropy {
    const window = this.currentMessages.slice(-30);
    let toolCallsInWindow = 0;
    let stateChangesInWindow = 0;
    let newErrorsInWindow = 0;
    const touchedResources = new Set<string>();
    let repeatedResourceReads = 0;
    const resourceReadCount = new Map<string, number>();

    for (const msg of window) {
      // 统计工具调用
      if (msg.role === 'assistant') {
        const toolCalls = this.extractToolCallsFromAssistant(msg);
        toolCallsInWindow += toolCalls.length;
      }

      // 统计工具结果
      if (msg.role === 'toolResult') {
        const content = getMessageContent(msg);
        const toolName = (msg as any).toolName || '';

        // 检测错误
        if (content.includes('Error') || content.includes('error') || content.includes('FAIL')) {
          newErrorsInWindow++;
        }

        // 检测文件变更
        if (content.includes('created') || content.includes('modified') || content.includes('written')) {
          stateChangesInWindow++;
        }

        // 跟踪资源
        const filePath = (msg as any).filePath || (msg as any).path || '';
        if (filePath) {
          touchedResources.add(filePath);
          const count = (resourceReadCount.get(filePath) || 0) + 1;
          resourceReadCount.set(filePath, count);
          if (count > 1) {
            repeatedResourceReads++;
          }
        }
      }

      // 用户消息中的资源引用
      if (msg.role === 'user') {
        const content = getMessageContent(msg);
        const fileRefs = content.match(/[\w\-./]+\.[a-zA-Z]+/g);
        if (fileRefs) {
          for (const ref of fileRefs) {
            touchedResources.add(ref);
          }
        }
        // 用户提供新信息也算状态变化
        if (content.length > 20) {
          stateChangesInWindow++;
        }
      }
    }

    // 探索效率 = 成功状态变化 / 总工具调用
    const explorationEfficiency = toolCallsInWindow > 0
      ? Math.min(1, stateChangesInWindow / toolCallsInWindow)
      : 1.0;

    // 低价值探索：很多工具调用但很少状态变化
    const isInLowValueExploration = toolCallsInWindow >= 8 &&
      stateChangesInWindow < Math.max(1, toolCallsInWindow * 0.15);

    return {
      toolCallsInWindow,
      stateChangesInWindow,
      newErrorsInWindow,
      uniqueResourcesTouched: touchedResources.size,
      repeatedResourceReads,
      isInLowValueExploration,
      explorationEfficiency,
    };
  }

  /**
   * 将健康级别字符串转为数值用于比较
   */
  private levelFromHealth(level: string): number {
    const levels: Record<string, number> = {
      ok: 0,
      attention: 1,
      warning: 2,
      critical: 3,
      emergency: 4,
      fatal: 5,
    };
    return levels[level] ?? 0;
  }

  /**
   * 从助手消息中提取工具调用列表
   */
  private extractToolCallsFromAssistant(msg: AgentMessage): Array<{ id: string; name?: string }> {
    const calls: Array<{ id: string; name?: string }> = [];

    if ('content' in msg && Array.isArray((msg as any).content)) {
      for (const block of (msg as any).content) {
        if (block.type === 'toolCall' && block.id) {
          calls.push({ id: block.id, name: block.name });
        }
      }
    }

    const toolCalls = (msg as any).toolCalls || (msg as any).tool_calls;
    if (toolCalls && Array.isArray(toolCalls)) {
      for (const tc of toolCalls) {
        if (tc.id) {
          calls.push({ id: tc.id, name: tc.name || tc.function?.name });
        }
      }
    }

    return calls;
  }

  /**
   * 手动触发压缩
   */
  async compact(options: CompactOptions = {}): Promise<CompressionResult> {
    return this.runCompression(options.level || 'clean', options.trigger || 'manual', options.force);
  }

  /**
   * 在模型调用前检查是否需要压缩
   * 这是 ACR 的主要入口点，在每次调用模型前调用
   *
   * @param messages 当前消息列表
   * @returns 是否需要压缩及相关信息
   */
  async checkBeforeModelCall(messages: AgentMessage[]): Promise<{
    shouldCompact: boolean;       // 是否需要压缩
    level?: CompressionLevel;     // 建议的压缩级别
    reasons: string[];            // 触发原因列表
    tokenHealth?: import('./types').TokenHealth;  // Token 健康状态
    messages?: AgentMessage[];    // 处理后的消息
  }> {
    this.currentMessages = [...messages];
    this.currentTurn++;

    // 更新状态（从消息和工作区提取）
    await this.stateExtractor.extract(
      this.currentMessages,
      this.config.monitors.workspaceObserver.enabled ? this.workspaceObserver : null,
      this.recentToolResults,
    );
    this.recentToolResults = [];

    // 健康检查
    const tokens = this.tokenMonitor.estimateTokens(messages);
    const tokenHealth = this.tokenMonitor.check(tokens);
    const density = this.densityMonitor.check(messages, tokens);
    const reasons: string[] = [];

    // 记录健康检查指标
    this.metrics.recordHealthCheck(tokenHealth.level, tokens, density.density);

    // 调试日志
    if (this.config.observability.debug || this.config.observability.logHealthChecks) {
      logger.debug({
        turn: this.currentTurn,
        tokens,
        ratio: tokenHealth.ratio.toFixed(2),
        health: tokenHealth.level,
        density: density.density.toFixed(2),
        compressionCount: this.compressionCount,
      }, '[ACR] 健康检查');
    }

    // 决定压缩级别
    let requiredLevel: CompressionLevel | null = null;

    // 基于 Token 的触发
    const tokenLevel = this.tokenMonitor.getRequiredCompressionLevel(tokenHealth);
    if (tokenLevel) {
      requiredLevel = tokenLevel;
      reasons.push('token_limit');
    }

    // 基于价值密度的触发（主动/早期压缩）
    if (density.density < this.config.monitors.valueDensity.threshold) {
      if (!requiredLevel || this.levelSeverity(requiredLevel) < this.levelSeverity('clean')) {
        requiredLevel = 'clean';
      }
      reasons.push('value_density');
    }

    // 不需要压缩
    if (!requiredLevel) {
      return { shouldCompact: false, reasons: [] };
    }

    // 检查冷却期
    if (this.isInCooldown(requiredLevel)) {
      if (this.config.observability.debug) {
        logger.debug({ level: requiredLevel }, '[ACR] 冷却中，跳过压缩');
      }
      return { shouldCompact: false, reasons: [] };
    }

    // 检查最大压缩次数限制
    if (this.compressionCount >= this.config.compression.cooldown.maxCompressionsPerSession) {
      if (requiredLevel !== 'emergency') {
        logger.warn('[ACR] 已达最大压缩次数，仅允许 L1 清理');
        if (this.levelSeverity(requiredLevel) > this.levelSeverity('clean')) {
          requiredLevel = 'clean';
        }
      }
    }

    return {
      shouldCompact: true,
      level: requiredLevel,
      reasons,
      tokenHealth,
    };
  }

  /**
   * 应用压缩到消息列表
   * @returns 压缩后的消息列表
   */
  async applyCompression(level: CompressionLevel, trigger: string): Promise<AgentMessage[]> {
    await this.runCompression(level, trigger, false);
    return this.currentMessages;
  }

  /**
   * 执行压缩并返回完整结果（含统计数据）
   */
  async compressAndGetResult(level: CompressionLevel, trigger: string): Promise<{
    messages: AgentMessage[];       // 压缩后的消息
    tokensSaved: number;            // 节省的 token 数
    compressionRatio: number;       // 压缩率
    durationMs: number;             // 耗时（毫秒）
    messagesBefore: number;         // 压缩前消息数
    messagesAfter: number;          // 压缩后消息数
    stateVersion: number;           // 状态版本号
    transitionMessage?: string;     // 过渡消息
    strategiesUsed: string[];       // 使用的策略
    success: boolean;               // 是否成功
  }> {
    const result = await this.runCompression(level, trigger, false);
    return {
      messages: this.currentMessages,
      tokensSaved: result.tokensSaved,
      compressionRatio: result.compressionRatio,
      durationMs: result.durationMs,
      messagesBefore: result.messagesBefore,
      messagesAfter: result.messagesAfter,
      stateVersion: result.stateVersion,
      transitionMessage: result.transitionMessage,
      strategiesUsed: result.strategiesUsed,
      success: result.success,
    };
  }

  /**
   * 工具调用后的观察处理
   * 在每次工具调用返回后调用，用于更新状态和生成摘要
   */
  observeAfterToolCall(
    toolName: string,
    args: unknown,
    result: { success: boolean; output?: string; error?: string },
  ): void {
    // 提取涉及的文件
    const files = this.extractFilesFromToolResult(toolName, args, result);
    this.recentToolResults.push({
      toolName,
      success: result.success,
      output: result.output,
      error: result.error,
      files,
    });

    // 生成工具输出摘要
    const content = result.output || result.error || '';
    if (content && this.toolDigestor.needsDigest(content)) {
      const digest = this.toolDigestor.digest(toolName, content, !result.success);
      this.toolDigests.push(digest);
      this.metrics.recordToolDigest();
    }

    // 调度工作区检查
    if (this.config.monitors.workspaceObserver.enabled) {
      this.workspaceObserver.scheduleCheck();
      this.workspaceObserver.updateFromToolResult(toolName, result, files);
    }
  }

  /**
   * 重置为新会话状态
   */
  reset(): void {
    this.currentMessages = [];
    this.recentToolResults = [];
    this.toolDigests = [];
    this.currentTurn = 0;
    this.lastCompressionTurn = -100;
    this.compressionCount = 0;
    this.cooldownLevelLastRun = {
      clean: -100,
      window: -100,
      collapse: -100,
      snapshot: -100,
      emergency: -100,
    };
    this.stateExtractor.reset();
    this.sessionMemory.clear();
    this.sessionMemory.init(createInitialState());
    this.metrics.reset();
    this.densityMonitor.reset();
  }

  /**
   * 检查 ACR 是否已启用
   */
  get isEnabled(): boolean {
    return this.config.enabled;
  }

  // ─── AgentHook 接口实现 ───

  /** 会话开始时调用 */
  async onStart(context: AgentRunHookContext): Promise<void> {
    this.currentMessages = [...context.messages];
    this.currentTurn = 0;
    logger.debug('[ACR] 会话开始');
  }

  /** 收到消息时调用 */
  async onMessage(context: AgentHookContext): Promise<void> {
    // 可在此处理消息
  }

  /** 工具调用前调用 */
  async onToolCall(context: AgentToolHookContext): Promise<void> {
    // 工具调用前的处理
  }

  /** 工具返回结果时调用 */
  async onToolResult(context: AgentToolHookContext): Promise<void> {
    const result = context.result as { success?: boolean; output?: string; error?: string };
    this.observeAfterToolCall(
      context.toolName,
      context.args,
      {
        success: result?.success !== false,
        output: result?.output,
        error: result?.error,
      },
    );
  }

  /** 会话结束时调用 */
  async onEnd(context: AgentRunHookContext): Promise<void> {
    // 会话结束 - 可在此持久化记忆
    logger.debug({ compressionCount: this.compressionCount }, '[ACR] 会话结束');
  }

  // ─── 内部方法 - 压缩流水线 ───

  /**
   * 执行压缩的核心方法
   * 完整的压缩流水线：
   * 1. 获取最新状态
   * 2. 提取记忆写入
   * 3. 执行压缩策略（L1 → L2 → ...）
   * 4. 确保工具配对完整性
   * 5. 插入状态快照
   * 6. 添加过渡消息
   * 7. 更新状态和记忆
   */
  private async runCompression(
    level: CompressionLevel,
    trigger: string,
    force: boolean = false,
  ): Promise<CompressionResult> {
    const startTime = Date.now();
    const messagesBefore = this.currentMessages.length;
    const tokensBefore = this.tokenMonitor.estimateTokens(this.currentMessages);

    logger.info({
      level,
      trigger,
      turn: this.currentTurn,
      tokensBefore,
      messagesBefore,
    }, '[ACR] 开始压缩');

    // 发出压缩开始事件
    this.emit({
      type: 'compression_start',
      timestamp: startTime,
      data: { level, trigger, tokensBefore },
    });

    try {
      // 1. 获取最新状态
      const state = await this.stateExtractor.extract(
        this.currentMessages,
        this.config.monitors.workspaceObserver.enabled ? this.workspaceObserver : null,
        this.recentToolResults,
      );

      // 2. 提取记忆写入
      const memoryWrites = this.sessionMemory.extractWrites(this.currentMessages);

      // 3. 执行压缩流水线
      let compressed = [...this.currentMessages];
      const strategiesRun: string[] = [];
      let toolDigestsCreated = 0;
      let pairingFixes = 0;

      // 先移除旧的状态快照
      compressed = removeStateSnapshots(compressed);

      // ─── L1: 清理（始终执行） ───
      let l1Digests: ToolDigest[] = [];
      try {
        const l1Result = runL1Clean(compressed, this.config.compression.strategies.l1_clean, this.toolDigestor);
        compressed = l1Result.messages;
        l1Digests = l1Result.digests;
        this.toolDigests.push(...l1Result.digests);
        toolDigestsCreated = l1Result.digestedCount;
        strategiesRun.push('l1_clean');
      } catch (err) {
        logger.warn({ err }, '[ACR] L1 清理失败，跳过');
      }

      // ─── L2: 窗口 ───
      if (level === 'window' || level === 'collapse') {
        try {
          const l2Result = runL2Window(compressed, this.config.compression.strategies.l2_window);
          compressed = l2Result.messages;
          strategiesRun.push('l2_window');
        } catch (err) {
          logger.warn({ err }, '[ACR] L2 窗口化失败，跳过');
        }
      }

      // ─── L3: 折叠 ───
      if (level === 'collapse') {
        try {
          const l3Result = runL3Collapse(compressed, this.config.compression.strategies.l3_collapse);
          compressed = l3Result.messages;
          strategiesRun.push('l3_collapse');
        } catch (err) {
          logger.warn({ err }, '[ACR] L3 折叠失败，跳过');
        }
      }

      // ─── L4: 快照重写 ───
      if (level === 'snapshot') {
        // L4 是独立策略，不经过 L2/L3
        try {
          const l4Result = runL4Snapshot(
            compressed,
            this.stateExtractor.getState(),
            this.config.compression.strategies.l4_snapshot_rewrite,
            this.toolDigests,
            this.systemPrompt,
          );
          compressed = l4Result.messages;
          strategiesRun.push('l4_snapshot_rewrite');
        } catch (err) {
          logger.warn({ err }, '[ACR] L4 快照重建失败，回退到 L2');
          // 降级到 L2
          try {
            const l2Result = runL2Window(compressed, this.config.compression.strategies.l2_window);
            compressed = l2Result.messages;
            strategiesRun.push('l2_window_fallback');
          } catch (l2Err) {
            logger.warn({ err: l2Err }, '[ACR] L2 降级也失败');
          }
        }
      }

      // ─── L5: 紧急压缩 ───
      if (level === 'emergency') {
        try {
          const l5Result = runL5Emergency(
            compressed,
            this.stateExtractor.getState(),
            this.config.compression.strategies.l5_emergency,
            this.systemPrompt,
          );
          compressed = l5Result.messages;
          strategiesRun.push('l5_emergency');
        } catch (err) {
          logger.warn({ err }, '[ACR] L5 紧急压缩失败，回退到 L2');
          // 降级到 L2（至少做窗口化）
          try {
            // 先做 L1 清理（确保已清理）
            const l1Fallback = runL1Clean(compressed, this.config.compression.strategies.l1_clean, this.toolDigestor);
            compressed = l1Fallback.messages;
            this.toolDigests.push(...l1Fallback.digests);
            strategiesRun.push('l1_fallback');
            // 再做 L2 窗口
            const l2Fallback = runL2Window(compressed, this.config.compression.strategies.l2_window);
            compressed = l2Fallback.messages;
            strategiesRun.push('l2_window_fallback');
          } catch (fallbackErr) {
            logger.warn({ err: fallbackErr }, '[ACR] 所有降级策略均失败');
          }
        }
      }

      // 压缩后自检：如果压缩后 token 仍然超过致命阈值，自动升级压缩级别
      if (this.config.compression.cooldown.postCompressionCheck) {
        const postTokens = this.tokenMonitor.estimateTokens(compressed);
        const postCheck = this.tokenMonitor.check(postTokens);
        if (postCheck.level === 'fatal' || postCheck.level === 'emergency') {
          const escalate: Record<string, CompressionLevel> = {
            clean: 'window',
            window: 'collapse',
            collapse: 'snapshot',
            snapshot: 'emergency',
          };
          const nextLevel = escalate[level];
          if (nextLevel) {
            logger.warn({ from: level, to: nextLevel, postTokens }, '[ACR] 压缩后 token 仍然过高，自动升级到 %s', nextLevel);
            try {
              if (nextLevel === 'window') {
                const l2Post = runL2Window(compressed, this.config.compression.strategies.l2_window);
                compressed = l2Post.messages;
                strategiesRun.push('l2_window_post_check');
              } else if (nextLevel === 'collapse') {
                const l3Post = runL3Collapse(compressed, this.config.compression.strategies.l3_collapse);
                compressed = l3Post.messages;
                strategiesRun.push('l3_collapse_post_check');
              } else if (nextLevel === 'snapshot') {
                const l4Post = runL4Snapshot(
                  compressed,
                  this.stateExtractor.getState(),
                  this.config.compression.strategies.l4_snapshot_rewrite,
                  this.toolDigests,
                  this.systemPrompt,
                );
                compressed = l4Post.messages;
                strategiesRun.push('l4_snapshot_post_check');
              } else if (nextLevel === 'emergency') {
                const l5Post = runL5Emergency(
                  compressed,
                  this.stateExtractor.getState(),
                  this.config.compression.strategies.l5_emergency,
                  this.systemPrompt,
                );
                compressed = l5Post.messages;
                strategiesRun.push('l5_emergency_post_check');
              }
            } catch (e) {
              logger.warn({ err: e }, '[ACR] 升级压缩失败');
            }
          }
        }
      }

      // 确保工具配对完整性
      const pairingBefore = countOrphanedPairs(compressed);
      compressed = ensureToolPairing(compressed);
      pairingFixes = pairingBefore.fixed;
      if (pairingFixes > 0) {
        this.metrics.recordPairingFixes(pairingFixes);
      }

      // 4. 构建过渡消息内容
      const transitionContent = createTransitionMessage(level, this.config.compression.transitionMessages, {
        tokensSaved: 0,
        compressionRatio: 0,
      });

      // 5. 在正确位置插入状态快照
      const stateSnapshot = createStateSnapshotMessage(formatStateSnapshot(state));

      // 插入到开头（作为状态摘要）
      compressed.unshift(stateSnapshot);

      // 在末尾添加过渡消息
      if (transitionContent) {
        const transitionMsg = {
          role: 'compactionSummary' as const,
          summary: transitionContent,
          tokensBefore: tokensBefore,
          timestamp: Date.now(),
        } as unknown as AgentMessage;
        compressed.push(transitionMsg);
      }

      // 应用 layerBudget：在添加完所有消息后执行预算控制
      // 如有需要会从非关键消息中继续截断
      this.enforceLayerBudget(compressed);

      // 6. 最终验证 - 再次确保工具配对
      compressed = ensureToolPairing(compressed);

      // 7. 更新状态
      this.currentMessages = compressed;
      this.stateExtractor.incrementCompressionCount();
      this.compressionCount++;
      this.lastCompressionTurn = this.currentTurn;
      this.cooldownLevelLastRun[level] = this.currentTurn;

      // 更新会话记忆
      this.sessionMemory.updateState(this.stateExtractor.getState());
      this.sessionMemory.updateRecentContext(compressed.slice(-this.config.compression.strategies.l2_window.recent_messages_to_keep));
      this.sessionMemory.addToolDigests(l1Digests);

      // 计算结果
      const tokensAfter = this.tokenMonitor.estimateTokens(compressed);
      const tokensSaved = tokensBefore - tokensAfter;
      const compressionRatio = tokensBefore > 0 ? tokensSaved / tokensBefore : 0;

      // 用实际统计数据更新过渡消息
      let finalTransitionMessage = transitionContent;
      if (transitionContent && tokensSaved > 0) {
        const percent = Math.round(compressionRatio * 100);
        finalTransitionMessage = transitionContent.replace(
          /。$/,
          ` (节省 ~${tokensSaved} tokens, ${percent}%)。`,
        );
        // 更新最后一条消息（过渡消息）的内容
        if (compressed.length > 0) {
          const lastMsg = compressed[compressed.length - 1];
          if (lastMsg.role === 'compactionSummary' && 'summary' in lastMsg) {
            (lastMsg as any).summary = finalTransitionMessage;
          }
        }
      }

      // 构建结果对象
      const result: CompressionResult = {
        success: true,
        level,
        trigger,
        strategiesUsed: strategiesRun,
        tokensBefore,
        tokensAfter,
        tokensSaved,
        compressionRatio,
        messagesBefore,
        messagesAfter: compressed.length,
        durationMs: Date.now() - startTime,
        stateVersion: state.metadata.snapshotVersion,
        transitionMessage: finalTransitionMessage || undefined,
        toolDigestsCreated,
        memoryWrites: {
          session: 1,
          workspace: memoryWrites.decisions.length,
          user: memoryWrites.userPreferences.length,
        },
      };

      // 记录压缩指标
      this.metrics.recordCompression(result);

      logger.info({
        ...result,
        pairingFixes,
      }, '[ACR] 压缩完成');

      // 发出压缩完成事件
      this.emit({
        type: 'compression_complete',
        timestamp: Date.now(),
        data: result,
      });

      return result;
    } catch (err) {
      // 压缩失败处理
      logger.error({ err, level, trigger }, '[ACR] 压缩失败');
      return {
        success: false,
        level,
        trigger,
        strategiesUsed: [],
        tokensBefore,
        tokensAfter: tokensBefore,
        tokensSaved: 0,
        compressionRatio: 0,
        messagesBefore,
        messagesAfter: messagesBefore,
        durationMs: Date.now() - startTime,
        stateVersion: this.stateExtractor.getState().metadata.snapshotVersion,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // ─── 内部方法 - 辅助函数 ───

  /**
   * 获取压缩级别的严重程度数值（用于比较）
   * 数值越大越严重
   */
  private levelSeverity(level: CompressionLevel): number {
    const severities: Record<CompressionLevel, number> = {
      clean: 1,
      window: 2,
      collapse: 3,
      snapshot: 4,
      emergency: 5,
    };
    return severities[level];
  }

  /**
   * 检查指定压缩级别是否在冷却期
   * 防止过于频繁的压缩
   */
  private isInCooldown(level: CompressionLevel): boolean {
    const minTurns = this.config.compression.cooldown.minTurnsBetweenSameLevel;
    const turnsSinceLast = this.currentTurn - this.cooldownLevelLastRun[level];
    const turnsSinceAny = this.currentTurn - this.lastCompressionTurn;

    // 同一级别在冷却期内不执行
    if (turnsSinceLast < minTurns) return true;

    // 更高级别的压缩可以更早执行（如果确实需要）
    if (this.levelSeverity(level) > this.levelSeverity('clean') && turnsSinceAny >= 2) {
      return false;
    }

    return turnsSinceAny < 2;
  }

  /**
   * 执行 layerBudget 预算控制
   * 根据配置的层级比例，在 token 预算超标时截断最近消息区
   * @returns 是否执行了预算截断
   */
  private enforceLayerBudget(messages: AgentMessage[]): boolean {
    const budget = this.config.layerBudget;
    const recentRatio = budget.recent; // 最近消息允许的比例
    const safetyMargin = budget.safetyMargin; // 安全余量

    // 只对超过一定规模的消息列表执行预算控制
    if (messages.length < 10) return false;

    // 估算总 token 和目标上限（含安全余量）
    const totalTokens = this.tokenMonitor.estimateTokens(messages);
    const targetMax = this.config.contextLimit * (1 - safetyMargin);

    if (totalTokens <= targetMax) return false; // 没超预算

    // 计算需要释放的 token
    const tokensToFree = totalTokens - targetMax;
    let freed = 0;

    // 策略：从非关键消息中截断
    // 优先移除旧的压缩摘要和自定义消息
    const toRemove: number[] = [];

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role === 'compactionSummary' || 
          (msg.role === 'custom' && (msg as any).display === false)) {
        toRemove.push(i);
        freed += estimateMessageTokens(messages[i]) + 10; // + 消息开销
        if (freed >= tokensToFree) break;
      }
    }

    // 如果还不够，移除旧的状态快照
    if (freed < tokensToFree) {
      for (let i = 0; i < messages.length; i++) {
        if (isStateSnapshot(messages[i])) {
          if (!toRemove.includes(i)) {
            toRemove.push(i);
            freed += estimateMessageTokens(messages[i]) + 10;
            if (freed >= tokensToFree) break;
          }
        }
      }
    }

    // 如果还不够，从最近消息之前的历史消息中截断
    if (freed < tokensToFree) {
      const recentStart = Math.max(0, messages.length - Math.ceil(messages.length * recentRatio));
      for (let i = recentStart - 1; i >= 0; i--) {
        if (!toRemove.includes(i) && (messages[i].role as string) !== 'system') {
          toRemove.push(i);
          freed += estimateMessageTokens(messages[i]) + 10;
          if (freed >= tokensToFree) break;
        }
      }
    }

    if (toRemove.length > 0) {
      // 原地修改：移除标记的消息
      // 使用 splice 从后往前删除
      const sorted = [...toRemove].sort((a, b) => b - a);
      for (const idx of sorted) {
        messages.splice(idx, 1);
      }
      logger.debug({ removed: sorted.length, freed }, '[ACR] layerBudget 已执行预算控制');
      return true;
    }

    return false;
  }

  /**
   * 从工具结果中提取涉及的文件信息
   */
  private extractFilesFromToolResult(
    toolName: string,
    args: unknown,
    result: { success: boolean; output?: string; error?: string },
  ): { path: string; action: 'read' | 'write' | 'edit' | 'delete' }[] {
    const files: { path: string; action: 'read' | 'write' | 'edit' | 'delete' }[] = [];
    const argsObj = args as Record<string, unknown>;

    // 从参数中提取文件路径
    const path = argsObj?.file_path || argsObj?.path || argsObj?.file;
    if (path && typeof path === 'string') {
      let action: 'read' | 'write' | 'edit' | 'delete' = 'read';
      if (toolName.includes('write') || toolName.includes('create')) action = 'write';
      else if (toolName.includes('edit') || toolName.includes('update')) action = 'edit';
      else if (toolName.includes('delete') || toolName.includes('remove')) action = 'delete';
      files.push({ path, action });
    }

    return files;
  }

  /**
   * 发出事件给所有监听器
   */
  private emit(event: ACREvent): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch (err) {
        logger.debug({ err }, 'ACR 事件监听器出错');
      }
    }
  }
}
