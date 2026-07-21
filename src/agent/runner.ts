import { logger } from '../utils/logger.js';
import { generateId, isBlankText, stripReasoningTags, buildAssistantMessage } from '../utils/helpers.js';
import { EMPTY_FINAL_RESPONSE_MESSAGE, buildGoalContinueMessage } from '../utils/runtime.js';
import { ToolRegistry } from './tools/registry.js';
import { ToolContext } from './tools/base.js';
import {
  LLMProvider,
  LLMRuntime,
  LLMResponse,
  ProviderMessage,
  StreamCallback,
  StreamResult,
  ToolCallRequest,
  parseToolArguments,
} from '../providers/base.js';

export interface FileEditEvent {
  type: 'file_edit_start' | 'file_edit_end' | 'file_edit_error';
  call_id: string;
  tool_name: string;
  file_path?: string;
  action?: string;
  error?: string;
}

export type FileEditCallback = (event: FileEditEvent) => Promise<void>;

const FILE_EDIT_TOOLS = new Set([
  'write_file',
  'edit_file',
  'apply_patch',
  'delete_file',
  'rename_file',
  'create_directory',
  'remove_directory',
]);

export interface AgentRunSpec {
  initialMessages: ProviderMessage[];
  tools: ToolRegistry;
  runtime: LLMRuntime;
  provider: LLMProvider;
  maxIterations: number;
  maxToolResultChars: number;
  workspace?: string;
  sessionKey?: string;
  channel?: string;
  chatId?: string;
  senderId?: string;
  stream?: boolean;
  onStream?: (delta: string) => Promise<void>;
  onReasoning?: (delta: string) => Promise<void>;
  onToolStart?: (toolName: string, toolCallId: string) => void;
  onToolComplete?: (toolName: string, toolCallId: string, result: string) => void;
  onToolError?: (toolName: string, toolCallId: string, error: string) => void;
  onFileEdit?: FileEditCallback;
}

export interface AgentRunResult {
  finalContent: string | null;
  messages: ProviderMessage[];
  toolsUsed: string[];
  usage: Record<string, number>;
  stopReason: string;
  error?: string;
  toolEvents: Array<{ name: string; id: string; status: string }>;
}

const MAX_EMPTY_RETRIES = 2;
const MAX_LENGTH_RECOVERIES = 3;

export class AgentRunner {
  async run(spec: AgentRunSpec): Promise<AgentRunResult> {
    const {
      initialMessages,
      tools,
      runtime,
      provider,
      maxIterations,
      maxToolResultChars,
      workspace,
      sessionKey,
      channel = 'cli',
      chatId = 'direct',
      senderId = 'user',
      stream = false,
      onStream,
      onReasoning,
      onToolStart,
      onToolComplete,
      onToolError,
      onFileEdit,
    } = spec;

    const messages: ProviderMessage[] = [...initialMessages];
    const toolsUsed: string[] = [];
    const toolEvents: Array<{ name: string; id: string; status: string }> = [];
    let totalUsage: Record<string, number> = {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
    };
    let stopReason = 'completed';
    let emptyRetryCount = 0;
    let lengthRecoveryCount = 0;
    let finalContent: string | null = null;

    const toolContext: ToolContext = {
      session_key: sessionKey || 'default',
      channel,
      chat_id: chatId,
      sender_id: senderId,
      workspace,
    };

    let accumulatedText = '';
    let accumulatedReasoning = '';

    const streamCallback: StreamCallback = async (delta) => {
      if (delta.text_delta) {
        accumulatedText += delta.text_delta;
        if (onStream) {
          await onStream(delta.text_delta);
        }
      }
      if (delta.reasoning_delta) {
        accumulatedReasoning += delta.reasoning_delta;
        if (onReasoning) {
          await onReasoning(delta.reasoning_delta);
        }
      }
    };

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      logger.debug({ iteration }, 'Agent loop iteration');

      let response: LLMResponse | StreamResult;
      accumulatedText = '';
      accumulatedReasoning = '';

      try {
        const toolDefs = tools.getToolDefinitions();
        
        if (stream && onStream) {
          response = await provider.stream(
            messages,
            toolDefs,
            runtime,
            streamCallback,
          );
        } else {
          response = await provider.complete(
            messages,
            toolDefs,
            runtime,
          );
          if (response.content) {
            accumulatedText = response.content;
          }
          if (response.reasoning_content) {
            accumulatedReasoning = response.reasoning_content;
          }
        }

        totalUsage = this.accumulateUsage(totalUsage, response.usage as unknown as Record<string, number>);
      } catch (err) {
        logger.error({ err }, 'LLM provider error');
        
        if (this.isLengthError(err) && lengthRecoveryCount < MAX_LENGTH_RECOVERIES) {
          lengthRecoveryCount++;
          logger.warn('Context length exceeded, attempting recovery');
          messages.push({
            role: 'user',
            content: 'The conversation is too long. Please summarize the key points and continue.',
          });
          continue;
        }
        
        return {
          finalContent: null,
          messages,
          toolsUsed,
          usage: totalUsage,
          stopReason: 'error',
          error: (err as Error).message,
          toolEvents,
        };
      }

      const assistantMsg = this.buildAssistantMessage(response);
      messages.push(assistantMsg);

      const hasToolCalls = response.tool_calls && response.tool_calls.length > 0;
      const hasContent = !isBlankText(response.content || (response as StreamResult).content);

      if (!hasToolCalls && hasContent) {
        if (isBlankText(stripReasoningTags(response.content || (response as StreamResult).content))) {
          if (emptyRetryCount < MAX_EMPTY_RETRIES) {
            emptyRetryCount++;
            messages.push({
              role: 'user',
              content: 'Your response was empty. Please provide a substantive reply.',
            });
            continue;
          }
          finalContent = EMPTY_FINAL_RESPONSE_MESSAGE;
        } else {
          finalContent = response.content || (response as StreamResult).content;
        }
        stopReason = response.stop_reason || 'completed';
        break;
      }

      if (!hasToolCalls && !hasContent) {
        if (response.stop_reason === 'length') {
          if (lengthRecoveryCount < MAX_LENGTH_RECOVERIES) {
            lengthRecoveryCount++;
            messages.push({
              role: 'user',
              content: 'Your response was cut off. Please continue from where you left off.',
            });
            continue;
          }
        }
        finalContent = EMPTY_FINAL_RESPONSE_MESSAGE;
        stopReason = 'empty';
        break;
      }

      if (hasToolCalls) {
        const toolResults: ProviderMessage[] = [];

        for (const toolCall of response.tool_calls) {
          if (!toolCall.name) continue;

          onToolStart?.(toolCall.name, toolCall.id);
          toolEvents.push({ name: toolCall.name, id: toolCall.id, status: 'started' });

          if (!toolsUsed.includes(toolCall.name)) {
            toolsUsed.push(toolCall.name);
          }

          const args = parseToolArguments(toolCall.arguments);

          // Emit file_edit_start for file editing tools
          if (onFileEdit && FILE_EDIT_TOOLS.has(toolCall.name)) {
            const filePath = typeof args === 'object' && args !== null
              ? ((args as Record<string, unknown>).file_path as string) ||
                ((args as Record<string, unknown>).path as string) ||
                ((args as Record<string, unknown>).file as string)
              : undefined;
            try {
              await onFileEdit({
                type: 'file_edit_start',
                call_id: toolCall.id,
                tool_name: toolCall.name,
                file_path: filePath,
                action: toolCall.name,
              });
            } catch (e) {
              logger.error({ err: e }, 'onFileEdit start callback error');
            }
          }

          const result = await tools.executeTool(
            toolCall.name,
            toolCall.id,
            args,
            toolContext,
            { maxResultChars: maxToolResultChars },
          );

          if (result.is_error) {
            onToolError?.(toolCall.name, toolCall.id, result.content);
            toolEvents.push({ name: toolCall.name, id: toolCall.id, status: 'failed' });
            if (onFileEdit && FILE_EDIT_TOOLS.has(toolCall.name)) {
              try {
                await onFileEdit({
                  type: 'file_edit_error',
                  call_id: toolCall.id,
                  tool_name: toolCall.name,
                  file_path: typeof args === 'object' && args !== null
                    ? ((args as Record<string, unknown>).file_path as string) ||
                      ((args as Record<string, unknown>).path as string)
                    : undefined,
                  action: toolCall.name,
                  error: result.content,
                });
              } catch (e) {
                logger.error({ err: e }, 'onFileEdit error callback error');
              }
            }
          } else {
            onToolComplete?.(toolCall.name, toolCall.id, result.content);
            toolEvents.push({ name: toolCall.name, id: toolCall.id, status: 'completed' });
            if (onFileEdit && FILE_EDIT_TOOLS.has(toolCall.name)) {
              try {
                await onFileEdit({
                  type: 'file_edit_end',
                  call_id: toolCall.id,
                  tool_name: toolCall.name,
                  file_path: typeof args === 'object' && args !== null
                    ? ((args as Record<string, unknown>).file_path as string) ||
                      ((args as Record<string, unknown>).path as string)
                    : undefined,
                  action: toolCall.name,
                });
              } catch (e) {
                logger.error({ err: e }, 'onFileEdit end callback error');
              }
            }
          }

          toolResults.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: result.content,
          });
        }

        messages.push(...toolResults);

        if (iteration >= maxIterations - 1) {
          messages.push({
            role: 'user',
            content: buildGoalContinueMessage(),
          });
        }
      }
    }

    return {
      finalContent,
      messages,
      toolsUsed,
      usage: totalUsage,
      stopReason,
      toolEvents,
    };
  }

  private buildAssistantMessage(response: LLMResponse | StreamResult): ProviderMessage {
    const msg: ProviderMessage = {
      role: 'assistant',
      content: response.content || '',
    };

    if (response.tool_calls && response.tool_calls.length > 0) {
      msg.tool_calls = response.tool_calls.map((tc: ToolCallRequest) => ({
        id: tc.id,
        name: tc.name,
        arguments: tc.arguments,
      }));
    }

    return msg;
  }

  private accumulateUsage(total: Record<string, number>, usage: Record<string, number>): Record<string, number> {
    return {
      input_tokens: (total.input_tokens || 0) + (usage.input_tokens || 0),
      output_tokens: (total.output_tokens || 0) + (usage.output_tokens || 0),
      total_tokens: (total.total_tokens || 0) + (usage.total_tokens || 0),
      cache_read_tokens: (total.cache_read_tokens || 0) + (usage.cache_read_tokens || 0),
      cache_write_tokens: (total.cache_write_tokens || 0) + (usage.cache_write_tokens || 0),
    };
  }

  private isLengthError(err: unknown): boolean {
    const msg = (err as Error)?.message?.toLowerCase() || '';
    return msg.includes('context length') || 
           msg.includes('maximum context') || 
           msg.includes('token limit') ||
           msg.includes('429') ||
           msg.includes('rate limit');
  }
}
