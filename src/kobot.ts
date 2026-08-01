import path from 'path';
import { Agent } from "./agent";
import type { AgentMessage, RunResult, SessionInfo } from "./agent";
import { builtinModels } from "./ai/providers-all";
import type { Model, AssistantMessage, Context, SimpleStreamOptions, Api } from "./ai";
import { loadConfig, getConfigPath } from "./config/loader";
import { Config } from "./config/schema";
import { createDefaultToolRegistry, ToolRegistry } from "./tools/registry";
import { setMemoryBaseDir } from "./tools/memory";
import { ContextBuilder } from "./agent";
import { SessionManager, createSessionManager } from "./storage/session-manager";
import type { MessageEntry, SessionTreeEntry } from "./storage/types";
import { logger, createLogger } from "./utils/logger";
import { ProgressGuard } from "./progress-guard";
import { AgentContextRuntime } from "./context-runtime";
import { ensureToolPairing } from "./context-runtime/compress/pairing";
import { SkillManager } from "./skill";

// 从拆分模块导入
import type { KobotEvent } from "./kobot/event-bus";
import { extractTextContent } from "./kobot/event-bus";
import { RequestQueue } from "./kobot/request-queue";
import { RunLoop } from "./kobot/run-loop";
import type { RunState } from "./kobot/run-loop";

// ─── 类型重新导出（保持公开 API 不变）────────────────────────────────

export type {
  KobotEvent,
  RunStartedEvent,
  RunFinishedEvent,
  RunFailedEvent,
  FileEditEvent,
  FileEditEventData,
} from "./kobot/event-bus";

export type { RunResult, SessionInfo } from "./agent";

// ─── 类型定义 ──────────────────────────────────────────────────────

export interface SessionDetail {
  key: string;
  createdAt: string;
  updatedAt: string;
  entries: Array<{
    id: string;
    parentId: string | null;
    type: string;
    timestamp: string;
    provider?: string;
    modelId?: string;
    message?: { role: string; content?: string };
    toolName?: string;
    toolCallId?: string;
    input?: Record<string, unknown>;
    content?: string;
    isError?: boolean;
    usage?: {
      input?: number;
      output?: number;
      total?: number;
    };
  }>;
}

export interface SessionSnapshot {
  key: string;
  messages: unknown[];
  metadata: Record<string, unknown>;
}

export interface RunOptions {
  sessionKey?: string;
  channel?: string;
  chatId?: string;
  senderId?: string;
  media?: string[];
  ephemeral?: boolean;
  model?: string;
  modelPreset?: string;
}

export interface KobotOptions {
  config?: Config;
  configPath?: string;
  workspace?: string;
  model?: string;
  modelPreset?: string;
}

export class Kobot {
  private config: Config;
  private toolRegistry: ToolRegistry;
  private agents: Map<string, Agent> = new Map();
  private acrRuntimes: Map<string, AgentContextRuntime> = new Map();
  private models: any;
  private sessionManager: SessionManager;
  private progressGuard: ProgressGuard;
  private requestQueue = new RequestQueue();
  private skillManager: SkillManager | null = null;

  private constructor(config: Config, toolRegistry: ToolRegistry, models: any) {
    this.config = config;
    this.toolRegistry = toolRegistry;
    this.models = models;
    this.sessionManager = createSessionManager({
      storageType: config.sessions?.storage === 'file' ? 'file' : 'memory',
      storagePath: config.sessions?.storage_path,
    });

    // 初始化 Progress Guard
    const pgConfig = config.progress_guard || {};
    this.progressGuard = new ProgressGuard({
      enabled: pgConfig.enabled ?? true,
      profile: pgConfig.profile ?? 'assistant',
      windowSize: pgConfig.window_size ?? 20,
      minTurnsBeforeDetect: pgConfig.min_turns_before_detect ?? 3,
      thresholds: {
        suspicious: pgConfig.suspicious_threshold ?? 0.4,
        stuck: pgConfig.stuck_threshold ?? 0.7,
        failed: pgConfig.failed_threshold ?? 0.9,
      },
      stateMachine: {
        confirmationTurns: pgConfig.confirmation_turns ?? 2,
        downgradeTurns: pgConfig.downgrade_turns ?? 3,
      },
      debug: pgConfig.debug ?? false,
    });

    // 监听 Progress Guard 事件
    this.progressGuard.on((event) => {
      switch (event.type) {
        case 'risk_change':
          logger.info({ level: event.level, score: event.score, previous: event.previousLevel }, '[PG] 风险等级已变更');
          break;
        case 'intervention':
          logger.warn({ level: event.level, action: event.action }, '[PG] 已触发干预');
          break;
        case 'progress_update':
          if (this.progressGuard.getDiagnosis().riskLevel !== 'normal') {
            logger.debug({ score: event.score, trend: event.trend, turn: event.turn }, '[PG] 进展更新');
          }
          break;
      }
    });
  }

  static async fromConfig(options: KobotOptions = {}): Promise<Kobot> {
    logger.info({ options }, '正在从配置初始化 Kobot');

    let config: Config;
    if (options.config) {
      config = options.config;
    } else {
      const configPath = options.configPath
        ? path.resolve(options.configPath.replace('~', process.env.HOME || ''))
        : getConfigPath();
      logger.debug({ configPath }, '正在加载配置');
      config = await loadConfig(configPath);
    }

    if (options.workspace) {
      config.agents.defaults.workspace = path.resolve(
        options.workspace.replace('~', process.env.HOME || ''),
      );
    }
    if (options.model) {
      config.agents.defaults.model_preset = undefined;
      config.agents.defaults.model = options.model;
      config.agents.defaults.provider = 'auto';
    } else if (options.modelPreset) {
      config.agents.defaults.model_preset = options.modelPreset;
    }

    // 使用配置初始化日志记录器
    if (config.logging) {
      createLogger(config.logging);
    }

    logger.debug({ model: config.agents.defaults.model, provider: config.agents.defaults.provider }, '模型配置');

    const toolRegistry = createDefaultToolRegistry();
    if (config.memory.base_dir) {
      setMemoryBaseDir(config.memory.base_dir);
    }

    const models = builtinModels();
    logger.info({ modelCount: models.getModels().length }, '已加载模型');

    const kobot = new Kobot(config, toolRegistry, models);

    // 初始化 SkillManager
    const workspace = config.agents.defaults.workspace || process.cwd();
    const skillsDir = config.agents.defaults.workspace
      ? path.resolve(config.agents.defaults.workspace, 'skills')
      : undefined;
    const skillManager = new SkillManager(toolRegistry, {
      skillsDir,
      workspace,
      disabledSkills: config.agents.defaults.disabled_skills,
    });
    const skillCount = skillManager.initialize();
    if (skillCount > 0) {
      kobot['skillManager'] = skillManager;
      logger.info({ skillCount }, 'Skill 系统已就绪');
    }

    return kobot;
  }

  private resolveModel(modelName?: string, modelPreset?: string): Model<any> {
    const defaults = this.config.agents.defaults;
    const resolvedModelName = modelName || defaults.model;
    const resolvedProvider = defaults.provider || 'auto';

    let model: Model<any> | undefined;
    try {
      const allModels: Model<any>[] = this.models.getModels();

      // 先尝试在配置的提供商中精确匹配
      if (resolvedProvider !== 'auto') {
        model = allModels.find((m: Model<any>) => m.id === resolvedModelName && m.provider === resolvedProvider);
      }

      // 如果未匹配到配置的提供商，尝试在 openai 提供商中精确匹配（最常见）
      if (!model) {
        model = allModels.find((m: Model<any>) => m.id === resolvedModelName && m.provider === 'openai');
      }

      // 如果仍未匹配，查找任意提供商中 ID 匹配的模型
      if (!model) {
        model = allModels.find((m: Model<any>) => m.id === resolvedModelName);
      }

      // 如果未精确匹配，尝试从配置的提供商中获取模型
      if (!model && resolvedProvider !== 'auto') {
        const providerModels = allModels.filter((m: Model<any>) => m.provider === resolvedProvider);
        if (providerModels.length > 0) {
          model = providerModels[0];
        }
      }

      // 如果仍未匹配，尝试查找任意 openai 模型
      if (!model) {
        const openaiModels = allModels.filter((m: Model<any>) => m.provider === 'openai');
        if (openaiModels.length > 0) {
          model = openaiModels[0];
        }
      }

      // 如果仍未匹配，使用第一个模型作为回退
      if (!model && allModels.length > 0) {
        model = allModels[0];
      }

      if (!model) {
        throw new Error('没有可用的模型');
      }
    } catch {
      model = {
        id: resolvedModelName,
        name: resolvedModelName,
        api: 'unknown',
        provider: resolvedProvider === 'auto' ? 'openai' : resolvedProvider,
        baseUrl: '',
        reasoning: false,
        input: [],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: defaults.context_window_tokens,
        maxTokens: defaults.max_tokens,
      };
    }

    return model!;
  }

  private getOrCreateACR(sessionKey: string, workspacePath?: string): AgentContextRuntime {
    const acrConfig = this.config.context_runtime;

    if (this.acrRuntimes.has(sessionKey)) {
      return this.acrRuntimes.get(sessionKey)!;
    }

    const workspace = workspacePath || this.config.agents.defaults.workspace || process.cwd();

    const acr = new AgentContextRuntime({
      workspacePath: workspace,
      config: {
        profile: acrConfig.profile as 'coding' | 'research' | 'assistant',
        contextLimit: acrConfig.context_limit || 128000,
      },
    });

    this.acrRuntimes.set(sessionKey, acr);
    logger.info({ sessionKey, profile: acrConfig.profile, contextLimit: acrConfig.context_limit }, 'ACR runtime created');
    return acr;
  }

  private async getOrCreateAgent(sessionKey: string): Promise<Agent> {
    if (this.agents.has(sessionKey)) {
      return this.agents.get(sessionKey)!;
    }

    const tools = this.toolRegistry.getAgentTools();
    const contextBuilder = ContextBuilder.create(this.config);
    const systemPrompt = contextBuilder.buildSystemPrompt();

    // 加载已保存的会话以恢复状态
    const savedSession = await this.sessionManager.loadSession(sessionKey);
    let model = this.resolveModel();
    let messages: AgentMessage[] = [];

    if (savedSession && savedSession.entries.length > 0) {
      // 恢复消息
      messages = savedSession.entries
        .filter((entry: SessionTreeEntry): entry is MessageEntry => entry.type === 'message')
        .map((entry: MessageEntry) => entry.message);

      // 恢复上次使用的模型
      const lastModelChange = [...savedSession.entries]
        .reverse()
        .find(entry => entry.type === 'model_change' ||
                      (entry.type === 'message' && entry.message.role === 'assistant' && entry.message.provider));

      if (lastModelChange) {
        let restoredProvider: string | undefined;
        let restoredModelId: string | undefined;

        if (lastModelChange.type === 'model_change') {
          restoredProvider = lastModelChange.provider;
          restoredModelId = lastModelChange.modelId;
        } else if (lastModelChange.type === 'message' && lastModelChange.message.role === 'assistant') {
          const msg = lastModelChange.message;
          if (msg.provider && msg.model) {
            restoredProvider = msg.provider as string;
            restoredModelId = msg.model as string;
          }
        }

        if (restoredProvider && restoredModelId) {
          try {
            const restoredModel = this.models.getModel(restoredModelId, restoredProvider);
            if (restoredModel) {
              model = restoredModel;
            }
          } catch {
            // 如果模型未找到，使用回退
            model = {
              id: restoredModelId,
              name: restoredModelId,
              api: 'unknown',
              provider: restoredProvider,
              baseUrl: '',
              reasoning: false,
              input: [],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: this.config.agents?.defaults?.context_window_tokens || 200000,
              maxTokens: this.config.agents?.defaults?.max_tokens || 8192,
            };
          }
        }
      }
    }

    // 获取或创建此会话的 ACR 运行时
    const acr = this.getOrCreateACR(sessionKey);

    let agent: Agent;

    agent = new Agent({
      initialState: {
        systemPrompt,
        model,
        thinkingLevel: 'off',
        tools,
        messages,
      },
      streamFn: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
        return this.models.streamSimple(model, context, options);
      },
      transformContext: async (messages, signal) => {
        try {
          const check = await acr.checkBeforeModelCall(messages);
          if (check.shouldCompact && check.level) {
            const trigger = check.reasons.length > 0 ? check.reasons[0] : 'manual';
            logger.info({
              level: check.level,
              trigger: check.reasons,
              messagesBefore: messages.length,
            }, 'ACR：已触发上下文压缩');

            const compressionResult = await acr.compressAndGetResult(check.level, trigger);

            logger.info({
              level: check.level,
              messagesBefore: compressionResult.messagesBefore,
              messagesAfter: compressionResult.messagesAfter,
              tokensSaved: compressionResult.tokensSaved,
              duration: compressionResult.durationMs,
            }, 'ACR：已应用上下文压缩');

            agent.state.messages = compressionResult.messages;

            // 确保工具配对完整性
            const paired = ensureToolPairing(compressionResult.messages);
            if (paired.length !== compressionResult.messages.length) {
              logger.debug({ removedCount: compressionResult.messages.length - paired.length }, 'transformContext 已移除孤立的工具调用/结果消息');
            }
            agent.state.messages = paired;
            return paired;
          }
        } catch (err) {
          logger.warn({ err: (err as Error).message }, 'ACR 压缩失败，跳过压缩');
        }

        // ACR 未触发或失败时仅做工具配对
        const pairedMessages = ensureToolPairing(messages);
        if (pairedMessages.length !== messages.length) {
          logger.debug({ removedCount: messages.length - pairedMessages.length }, 'transformContext 已移除孤立的工具调用/结果消息');
        }
        agent.state.messages = pairedMessages;
        return pairedMessages;
      },
    });

    this.agents.set(sessionKey, agent);
    return agent;
  }

  // ─── run() ──────────────────────────────────────────────────────────

  async run(message: string, options: RunOptions = {}): Promise<RunResult> {
    const sessionKey = options.sessionKey || 'sdk:default';
    return this.requestQueue.enqueue(sessionKey, () => this._run(message, options, sessionKey));
  }

  private async _run(message: string, options: RunOptions, sessionKey: string): Promise<RunResult> {
    const sessionStorage = this.sessionManager.getSessionStorage(sessionKey);

    const traceId = await sessionStorage.createEntryId();
    const parentId = await sessionStorage.getLeafId();

    logger.info({ sessionKey, traceId, parentId, message: message.substring(0, 50) }, '正在运行消息');

    const agent = await this.getOrCreateAgent(sessionKey);
    const acr = this.getOrCreateACR(sessionKey);

    const loop = new RunLoop({
      agent,
      sessionStorage,
      acr,
      progressGuard: this.progressGuard,
      sessionKey,
      traceId,
      parentId,
      model: agent.state.model,
    });

    loop.attachProgressGuard();
    await loop.recordModelChange();

    const state: RunState = { toolsUsed: [], finalContent: '', stopReason: 'completed' };
    const unsubscribe = agent.subscribe(loop.createEventHandler(state));

    try {
      const skillInjectedMessage = await this.prepareSkillInput(message, agent);
      await agent.prompt(skillInjectedMessage);
    } catch (err) {
      state.error = (err as Error).message;
      state.stopReason = 'error';
    } finally {
      unsubscribe();
    }

    return loop.buildResult(state);
  }

  // ─── stream() ───────────────────────────────────────────────────────

  async *stream(
    message: string,
    options: RunOptions = {},
  ): AsyncGenerator<KobotEvent> {
    const sessionKey = options.sessionKey || 'sdk:default';
    const { wait, release } = this.requestQueue.acquire(sessionKey);

    try {
      await wait;
    } catch {
      // 前一个请求的错误不影响当前请求
    }

    try {
      const sessionStorage = this.sessionManager.getSessionStorage(sessionKey);
      const agent = await this.getOrCreateAgent(sessionKey);
      const model = agent.state.model;
      const acr = this.getOrCreateACR(sessionKey);

      const loop = new RunLoop({
        agent,
        sessionStorage,
        acr,
        progressGuard: this.progressGuard,
        sessionKey,
        model,
      });

      loop.attachProgressGuard();
      await loop.recordModelChange();

      yield {
        type: 'run_started',
        metadata: {
          session_key: sessionKey,
          channel: options.channel || 'cli',
          chat_id: options.chatId || 'direct',
          sender_id: options.senderId || 'user',
        },
      };

      const state: RunState = { toolsUsed: [], finalContent: '', stopReason: 'completed' };

      const eventQueue: KobotEvent[] = [];
      let resolveNext: ((value: KobotEvent) => void) | null = null;

      const pushEvent = (event: KobotEvent): void => {
        if (resolveNext) {
          resolveNext(event);
          resolveNext = null;
        } else {
          eventQueue.push(event);
        }
      };

      const unsubscribe = agent.subscribe(
        loop.createEventHandler(
          state,
          pushEvent,
          (s) => {
            // agent_finished -> 推送 run_finished/run_failed
            const result: RunResult = {
              content: s.finalContent,
              toolsUsed: s.toolsUsed,
              usage: {},
              stopReason: s.stopReason,
              metadata: {},
              error: s.error,
            };
            if (s.error) {
              pushEvent({ type: 'run_failed', content: s.finalContent, error: s.error, result });
            } else {
              pushEvent({ type: 'run_finished', content: s.finalContent, result });
            }
          },
        ),
      );

      try {
        // 预处理：Skill 匹配与执行
        const skillInjectedMessage = await this.prepareSkillInput(message, agent);
        const runPromise = agent.prompt(skillInjectedMessage);

        while (true) {
          if (eventQueue.length > 0) {
            const event = eventQueue.shift()!;
            yield event;
            if (event.type === 'run_finished' || event.type === 'run_failed') {
              break;
            }
          } else {
            const event = await new Promise<KobotEvent>((resolve) => {
              resolveNext = resolve;
            });
            yield event;
            if (event.type === 'run_finished' || event.type === 'run_failed') {
              break;
            }
          }
        }

        await runPromise;

        if (!options.ephemeral) {
          await this.sessionManager.saveSession(sessionKey, agent.state.messages, {});
        }
      } catch (err) {
        state.error = (err as Error).message;
        state.stopReason = 'error';

        pushEvent({
          type: 'run_failed',
          content: state.finalContent,
          error: state.error,
          result: {
            content: state.finalContent,
            toolsUsed: state.toolsUsed,
            usage: {},
            stopReason: state.stopReason,
            metadata: {},
            error: state.error,
          },
        });

        if (!options.ephemeral) {
          await this.sessionManager.saveSession(sessionKey, agent.state.messages, {});
        }
      } finally {
        unsubscribe();
      }
    } finally {
      release();
    }
  }

  // ─── 会话管理 ───────────────────────────────────────────────────────

  async getSessionInfo(sessionKey: string): Promise<SessionInfo | null> {
    const storedInfo = await this.sessionManager.getSessionInfo(sessionKey);
    if (storedInfo) {
      return storedInfo;
    }

    const agent = this.agents.get(sessionKey);
    if (!agent) return null;

    const messages = agent.state.messages;
    return {
      key: sessionKey,
      messageCount: messages.length,
      createdAt: '',
      updatedAt: '',
    };
  }

  async getSessionDetail(sessionKey: string): Promise<SessionDetail | null> {
    const session = await this.sessionManager.loadSession(sessionKey);
    if (!session) return null;

    const entries = session.entries.map((entry: SessionTreeEntry) => {
      const base = {
        id: entry.id,
        parentId: entry.parentId,
        type: entry.type,
        timestamp: entry.timestamp,
      };

      switch (entry.type) {
        case 'model_change':
          return { ...base, provider: entry.provider, modelId: entry.modelId };
        case 'message': {
          const msg = entry.message as unknown as { role: string; content?: string | Array<{ type: string; text?: string }> };
          let content: string | undefined;
          if (typeof msg.content === 'string') {
            content = msg.content;
          } else if (Array.isArray(msg.content)) {
            content = msg.content.map((c: { text?: string }) => c.text).filter(Boolean).join('\n') || undefined;
          }
          return {
            ...base,
            message: {
              role: msg.role,
              content,
            },
          };
        }
        case 'tool_call':
          return { ...base, toolName: entry.toolName, toolCallId: entry.toolCallId, input: entry.input };
        case 'tool_result':
          return { ...base, toolName: entry.toolName, toolCallId: entry.toolCallId, input: entry.input, content: entry.content, isError: entry.isError, usage: entry.usage };
        case 'token_usage':
          return { ...base, usage: entry.usage };
        default:
          return base;
      }
    });

    return {
      key: session.key,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      entries,
    };
  }

  async listSessions(): Promise<string[]> {
    const storedSessions = await this.sessionManager.listSessions();
    const agentSessions = Array.from(this.agents.keys());
    return [...new Set([...storedSessions, ...agentSessions])];
  }

  async deleteSession(sessionKey: string): Promise<boolean> {
    this.agents.delete(sessionKey);
    this.acrRuntimes.delete(sessionKey);
    return this.sessionManager.deleteSession(sessionKey);
  }

  get tools(): string[] {
    return this.toolRegistry.list();
  }

  get config_(): Config {
    return this.config;
  }

  /** 获取 Progress Guard 实例 */
  get progressGuard_(): ProgressGuard {
    return this.progressGuard;
  }

  /** 获取 ACR runtime 实例（用于调试/监控） */
  getACR(sessionKey: string = 'sdk:default'): AgentContextRuntime | undefined {
    return this.acrRuntimes.get(sessionKey);
  }

  /** 获取 SkillManager 实例 */
  get skillManager_(): SkillManager | null {
    return this.skillManager;
  }

  /**
   * 预处理输入：检查 Skill 匹配，若匹配则注入编译后的 Skill 完整 prompt
   */
  private async prepareSkillInput(message: string, agent: Agent): Promise<string> {
    const sm = this.skillManager;
    if (!sm || !sm.registry.count()) return message;

    const match = sm.match(message, {
      currentFile: undefined, // Phase 2: 从 IDE/CLI 获取当前文件
    });

    if (!match.match || !match.matchedSkill) return message;

    logger.info({
      skillName: match.matchedSkill.manifest.name,
      level: match.match.level,
    }, '[SKILL] 匹配到 Skill，注入编译后的上下文');

    try {
      // 使用 Runtime 的 ContextManager + PromptCompiler 编译完整 prompt
      const { compiled } = await sm.compileSkillPrompt(match.matchedSkill, {
        userInput: message,
      });

      if (compiled) {
        agent.state.messages.push({
          role: 'system',
          content: compiled,
          timestamp: Date.now(),
        });
      }
    } catch (err) {
      logger.error({ error: (err as Error).message }, '[SKILL] Prompt 编译失败，跳过注入');
    }

    return message;
  }

  /**
   * 回放历史会话，按顺序重新发送用户消息以复现问题
   * @param sessionKey 要回放的历史会话 key
   * @param onProgress 可选进度回调，每轮开始前调用 (current, total, message)
   * @param onTurnResult 可选回合结果回调，每轮完成后立即调用 (current, total, result)
   * @returns 回放结果，包含每轮的输入/输出/错误信息
   */
  async replaySession(
    sessionKey: string,
    onProgress?: (current: number, total: number, message: string) => void,
    onTurnResult?: (current: number, total: number, result: { userMessage: string; response: string; error?: string }) => void,
  ): Promise<{
    sessionKey: string;
    userMessageCount: number;
    turns: Array<{
      index: number;
      userMessage: string;
      response: string;
      error?: string;
    }>;
    totalErrors: number;
    totalDurationMs: number;
  }> {
    // 1. 加载历史会话
    const session = await this.sessionManager.loadSession(sessionKey);
    if (!session) {
      throw new Error(`会话 "${sessionKey}" 未找到`);
    }

    // 2. 按顺序提取用户消息
    const userMessages: string[] = [];
    for (const entry of session.entries) {
      if (entry.type !== 'message' || entry.message.role !== 'user') continue;
      const msg = entry.message as unknown as Record<string, unknown>;
      if ('content' in msg) {
        const content = msg.content;
        if (typeof content === 'string') {
          userMessages.push(content);
        } else if (Array.isArray(content)) {
          const text = content
            .filter((c: unknown): c is { type: string; text?: string } =>
              typeof c === 'object' && c !== null && (c as Record<string, unknown>).type === 'text')
            .map((c: { text?: string }) => c.text || '')
            .join('\n');
          if (text) userMessages.push(text);
        }
      }
    }

    if (userMessages.length === 0) {
      throw new Error(`会话 "${sessionKey}" 中没有用户消息`);
    }

    logger.info({ sessionKey, userMessageCount: userMessages.length }, '[REPLAY] 开始回放会话');

    // 3. 创建新的回放 agent（清理之前的回放状态）
    const replayKey = `replay_${sessionKey}`;
    this.agents.delete(replayKey);
    this.acrRuntimes.delete(replayKey);
    const agent = await this.getOrCreateAgent(replayKey);

    // 4. 逐条回放用户消息
    const turns: Array<{
      index: number;
      userMessage: string;
      response: string;
      error?: string;
    }> = [];
    let totalErrors = 0;
    const startTime = Date.now();

    for (let i = 0; i < userMessages.length; i++) {
      const userMsg = userMessages[i];
      let response = '';
      let error: string | undefined;

      logger.info({ sessionKey, turnIndex: i, message: userMsg.substring(0, 80) },
        `[REPLAY] 第 ${i + 1}/${userMessages.length} 轮回放`);

      onProgress?.(i + 1, userMessages.length, userMsg.substring(0, 120));

      const unsubscribe = agent.subscribe((event) => {
        if (event.type === 'message_finished' && event.message.role === 'assistant') {
          const msg = event.message as AssistantMessage;
          response = extractTextContent(msg.content);
        }
      });

      try {
        await agent.prompt(userMsg);
      } catch (err) {
        error = (err as Error).message;
        totalErrors++;
        logger.error({ sessionKey, turnIndex: i, error }, '[REPLAY] 回放出错');
      } finally {
        unsubscribe();
      }

      turns.push({ index: i, userMessage: userMsg, response, error });
      onTurnResult?.(i + 1, userMessages.length, { userMessage: userMsg, response, error });
    }

    const duration = Date.now() - startTime;
    logger.info({ sessionKey, totalTurns: userMessages.length, totalErrors, durationMs: duration },
      '[REPLAY] 回放完成');

    return {
      sessionKey,
      userMessageCount: userMessages.length,
      turns,
      totalErrors,
      totalDurationMs: duration,
    };
  }

  /** 检查指定会话是否正在处理请求 */
  isBusy(sessionKey: string = 'sdk:default'): boolean {
    const agent = this.agents.get(sessionKey);
    return agent?.state.isStreaming ?? false;
  }

  /** 等待指定会话空闲 */
  async waitForIdle(sessionKey: string = 'sdk:default'): Promise<void> {
    const agent = this.agents.get(sessionKey);
    if (agent && agent.state.isStreaming) {
      await agent.waitForIdle();
    }
  }

  async close(): Promise<void> {
    this.agents.clear();
    this.acrRuntimes.clear();
    this.requestQueue.clear();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

export { Agent };
export { builtinModels };
