import type { Agent } from '../agent';
import type { AgentEvent, RunResult } from '../agent/types';
import type { Model, AssistantMessage, TextContent } from '../ai/types';
import type { SessionStorage } from '../storage/types';
import type { AgentContextRuntime } from '../context-runtime';
import type { ProgressGuard } from '../progress-guard';
import { logger } from '../utils/logger';
import { extractTextContent, FILE_EDIT_TOOLS } from './event-bus';
import type { KobotEvent } from './event-bus';

/** 运行过程中的可变状态 */
export interface RunState {
  toolsUsed: string[];
  finalContent: string;
  stopReason: string;
  error?: string;
}

export interface RunLoopDeps {
  agent: Agent;
  sessionStorage: SessionStorage;
  acr: AgentContextRuntime;
  progressGuard: ProgressGuard;
  sessionKey: string;
  traceId?: string;
  parentId?: string | null;
  model?: Model;
}

/**
 * 封装单次 Agent 运行的编排逻辑：
 * ProgressGuard 挂载、模型记录、Agent 事件订阅与持久化、ACR 观察。
 *
 * run() 和 stream() 的共享事件处理逻辑统一由 createEventHandler 提供，
 * 通过可选回调区分流式/非流式行为。
 */
export class RunLoop {
  constructor(private deps: RunLoopDeps) {}

  /** 挂载 ProgressGuard 到 Agent */
  attachProgressGuard(): void {
    const { progressGuard, agent } = this.deps;
    if (!progressGuard.isEnabled) return;

    progressGuard.reset();
    progressGuard.attach({
      steer: (msg: string) => {
        agent.state.messages.push({
          role: 'user',
          content: msg,
          timestamp: Date.now(),
        });
      },
      abort: (reason: string) => {
        logger.error({ reason }, '[PG] Agent 被 Progress Guard 中止');
        throw new Error(`Progress Guard: ${reason}`);
      },
    });
  }

  /** 记录模型变更到会话存储 */
  async recordModelChange(): Promise<void> {
    const { model, sessionStorage, parentId } = this.deps;
    if (!model) return;

    await sessionStorage.appendEntry({
      type: 'model_change',
      id: await sessionStorage.createEntryId(),
      parentId: parentId !== undefined ? parentId : await sessionStorage.getLeafId(),
      timestamp: new Date().toISOString(),
      provider: model.provider,
      modelId: model.id,
    });
  }

  /**
   * 创建 Agent 事件处理器——run() 和 stream() 的共享核心。
   *
   * @param state 运行状态（函数内原地修改）
   * @param onStreamEvent 可选，流式模式下用于向外推送 KobotEvent（text_chunk, tool 事件等）
   * @param onAgentFinished 可选，agent_finished 时调用（stream 模式用于推送 run_finished/run_failed）
   */
  createEventHandler(
    state: RunState,
    onStreamEvent?: (event: KobotEvent) => void,
    onAgentFinished?: (state: RunState) => void,
  ): (event: AgentEvent) => Promise<void> {
    const { sessionStorage, progressGuard, acr, sessionKey, traceId } = this.deps;

    return async (event) => {
      switch (event.type) {
        case 'agent_started':
          logger.info({ sessionKey, traceId }, '[AGENT_START] Agent 运行已开始');
          break;

        case 'agent_finished':
          logger.info({ sessionKey, traceId, messageCount: event.messages.length }, '[AGENT_END] Agent 运行已完成');
          onAgentFinished?.(state);
          break;

        case 'turn_started':
          logger.debug({ sessionKey, traceId }, '[TURN_START] 回合已开始');
          progressGuard.startTurn();
          break;

        case 'turn_finished': {
          const turnMsg = event.message as AssistantMessage;
          logger.debug(
            { sessionKey, traceId, stopReason: turnMsg.stopReason, toolResultCount: event.toolResults.length },
            '[TURN_END] 回合已完成',
          );
          break;
        }

        case 'message_started':
          logger.debug({ sessionKey, traceId, role: event.message.role }, '[MESSAGE_START] 消息已开始');
          if (event.message.role === 'assistant') {
            state.finalContent = '';
          }
          break;

        case 'message_updated':
          break;

        // 细粒度增量事件：仅流式模式下向外透传
        case 'text_chunk':
          onStreamEvent?.(event);
          break;
        case 'text_finished':
          state.finalContent = event.content;
          onStreamEvent?.(event);
          break;
        case 'thinking_chunk':
          onStreamEvent?.(event);
          break;

        case 'message_finished': {
          const msg = event.message as AssistantMessage;
          logger.debug({ sessionKey, traceId, role: event.message.role, stopReason: msg.stopReason }, '[MESSAGE_END] 消息已完成');

          // 存储消息条目
          await sessionStorage.appendEntry({
            type: 'message',
            id: await sessionStorage.createEntryId(),
            parentId: await sessionStorage.getLeafId(),
            timestamp: new Date().toISOString(),
            message: event.message,
          });

          if (event.message.role === 'assistant') {
            state.finalContent = extractTextContent(msg.content);
            state.stopReason = msg.stopReason || 'completed';
            state.error = msg.errorMessage;

            // Progress Guard: 记录助手输出
            if (state.finalContent) {
              progressGuard.recordAssistantOutput(state.finalContent, msg.usage?.totalTokens);
            }

            // 存储 token 用量
            if (msg.usage) {
              await sessionStorage.appendEntry({
                type: 'token_usage',
                id: await sessionStorage.createEntryId(),
                parentId: await sessionStorage.getLeafId(),
                timestamp: new Date().toISOString(),
                usage: msg.usage,
              });
            }
          }
          break;
        }

        case 'tool_started': {
          logger.info(
            { sessionKey, traceId, toolName: event.toolName, toolCallId: event.toolCallId, args: event.args },
            '[TOOL_START] 工具执行已开始',
          );

          // 存储工具调用条目
          await sessionStorage.appendEntry({
            type: 'tool_call',
            id: await sessionStorage.createEntryId(),
            parentId: await sessionStorage.getLeafId(),
            timestamp: new Date().toISOString(),
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            input: (event.args || {}) as Record<string, unknown>,
          });

          if (!state.toolsUsed.includes(event.toolName)) {
            state.toolsUsed.push(event.toolName);
          }

          onStreamEvent?.(event);

          // 文件编辑事件
          if (FILE_EDIT_TOOLS.has(event.toolName)) {
            const args = event.args as Record<string, unknown>;
            const filePath = args.file_path || args.path || args.file;
            onStreamEvent?.({
              type: 'file_edit',
              file_edit: {
                edit_type: 'start',
                call_id: event.toolCallId,
                tool_name: event.toolName,
                file_path: typeof filePath === 'string' ? filePath : undefined,
                action: event.toolName,
              },
            });
          }
          break;
        }

        case 'tool_progress':
          logger.debug({ sessionKey, traceId, toolName: event.toolName, toolCallId: event.toolCallId }, '[TOOL_UPDATE] 工具执行中');
          break;

        case 'tool_finished': {
          logger.info(
            { sessionKey, traceId, toolName: event.toolName, toolCallId: event.toolCallId, success: !event.isError },
            '[TOOL_END] 工具执行已完成',
          );

          // 存储工具结果条目
          const resultContent = event.result?.content
            ?.filter((c): c is TextContent => c.type === 'text')
            .map(c => c.text)
            .join('') || '';

          await sessionStorage.appendEntry({
            type: 'tool_result',
            id: await sessionStorage.createEntryId(),
            parentId: await sessionStorage.getLeafId(),
            timestamp: new Date().toISOString(),
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            input: (event.args ?? {}) as Record<string, unknown>,
            content: resultContent,
            isError: event.isError,
            usage: event.result?.usage,
          });

          onStreamEvent?.(event);

          // 文件编辑结束事件
          if (FILE_EDIT_TOOLS.has(event.toolName)) {
            const args = (event.args ?? {}) as Record<string, unknown>;
            const filePath = args.file_path || args.path;
            onStreamEvent?.({
              type: 'file_edit',
              file_edit: {
                edit_type: event.isError ? 'error' : 'end',
                call_id: event.toolCallId,
                tool_name: event.toolName,
                file_path: typeof filePath === 'string' ? filePath : undefined,
                action: event.toolName,
                error: event.isError ? resultContent : undefined,
              },
            });
          }

          // Progress Guard: 记录工具调用结果并检测
          if (progressGuard.isEnabled) {
            const pgIntervention = progressGuard.recordToolCall(
              event.toolName,
              (event.args ?? {}) as Record<string, unknown>,
              {
                success: !event.isError,
                output: resultContent,
                error: event.isError ? resultContent : undefined,
              },
            );
            if (pgIntervention === 'terminate') {
              logger.error({ sessionKey }, '[PG] Agent terminated by Progress Guard');
            }
          }

          // ACR: 记录工具调用结果用于状态提取和压缩
          acr.observeAfterToolCall(
            event.toolName,
            (event.args ?? {}) as Record<string, unknown>,
            {
              success: !event.isError,
              output: resultContent,
              error: event.isError ? resultContent : undefined,
            },
          );
          break;
        }
      }
    };
  }

  /** 构建 RunResult（包含完整 metadata，用于 run() 返回值） */
  buildResult(state: RunState): RunResult {
    const { model, traceId, parentId } = this.deps;
    return {
      content: state.finalContent,
      toolsUsed: state.toolsUsed,
      usage: {},
      stopReason: state.stopReason,
      metadata: {
        traceId,
        parentId,
        model: model ? { provider: model.provider, modelId: model.id } : null,
      },
      error: state.error,
    };
  }
}
