/**
 * 可选适配器:复用 aipack/ai 标准化模型层
 *
 * 为什么存在:
 *   aipack/ai 子模块实现了完整的模型标准化(模型目录 Models、streamOpenAI /
 *   streamAnthropic、认证解析、SSE 解析、用量统计等),与核心框架类型解耦。
 *   拿到标准化的 Model(例如 getBuiltinModel() / createModels() 得到),
 *   就不需要再手写 streamFn。
 *
 * 用法:
 * ```typescript
 * import {
 *   createRuntime,
 *   adaptAiModel,
 *   createStreamFnFromAi,
 *   getBuiltinModel,
 * } from '@aipack/agent';
 *
 * const aiModel = getBuiltinModel('openai', 'gpt-4o-mini');
 * const runtime = await createRuntime({
 *   model: adaptAiModel(aiModel),        // ai Model -> 框架 Model
 *   streamFn: createStreamFnFromAi(aiModel), // 自动对接 OpenAI / Anthropic
 * });
 * ```
 *
 * 注意:模型调用能力由 aipack/ai 提供;本适配器仅依赖 core 的类型与
 * extractText,不做运行时执行逻辑。
 */
import { streamOpenAI, streamAnthropic, hasApi } from '../ai';
import type {
  Model as AiModel,
  Context as AiContext,
  Message as AiMessage,
  StreamEvent as AiStreamEvent,
  SimpleStreamOptions,
  StreamOptions as AiStreamOptions,
  ReasoningLevel,
  AssistantMessage as AiAssistantMessage,
  ToolCallContent as AiToolCallContent,
  ContentBlock as AiContentBlock,
  TSchema,
} from '../ai';
import type {
  Model,
  StreamFn,
  StreamEvent,
  StreamOptions,
  ContentBlock,
} from '../core';
import { extractText } from '../core';

// ─── 模型适配 ───────────────────────────────────────────────────────

/** 将 aipack/ai 的标准 Model 转为框架 Model（id/name/provider/窗口/token 等信息） */
export function adaptAiModel(aiModel: AiModel): Model {
  return {
    id: aiModel.id,
    name: aiModel.name,
    provider: aiModel.provider,
    contextWindow: aiModel.contextWindow,
    maxTokens: aiModel.maxTokens,
    reasoning: aiModel.reasoning,
    // 透传 aipack/ai 的扩展字段（baseUrl、cost、headers、api 等），保留灵活性
    ...(aiModel as unknown as Record<string, unknown>),
  };
}

// ─── 事件映射 ───────────────────────────────────────────────────────

/** 将 aipack/ai 的 content 块规范化为框架 content 块（thinking 块字段不同） */
function normalizeBlocks(blocks: AiContentBlock[]): ContentBlock[] {
  return blocks.map(b => {
    if (b.type === 'thinking') {
      return { type: 'thinking', text: (b as { thinking?: string }).thinking ?? '' };
    }
    return b as unknown as ContentBlock;
  });
}

/** 将 aipack/ai 的 assistant 消息规范化为框架消息 */
function normalizeAssistantMessage(
  msg: AiAssistantMessage,
  stopReason?: string,
): import('../core').AssistantMessage {
  return {
    role: 'assistant',
    content: normalizeBlocks(msg.content),
    stopReason: msg.stopReason || stopReason || 'stop',
    usage: msg.usage,
    model: msg.model,
    provider: msg.provider,
    errorMessage: msg.errorMessage,
    responseId: msg.responseId,
    timestamp: Date.now(),
  };
}

/** 从 aipack/ai 的 partial message 中提取 contentIndex 对应的工具调用块 */
function findToolCall(
  partial: AiAssistantMessage,
  contentIndex: number,
  known: Map<number, AiToolCallContent>,
): AiToolCallContent | undefined {
  const block = partial.content[contentIndex] as
    | AiToolCallContent
    | undefined;
  if (block?.type === 'toolCall') return block;
  // 兜底：contentIndex 对不上时，在所有 content 中找未记录的 toolCall
  for (const b of partial.content) {
    if (b.type === 'toolCall' && !known.has(contentIndex)) return b;
  }
  return undefined;
}

// ─── streamFn 适配 ──────────────────────────────────────────────────

/**
 * 创建 StreamFn：内部使用 aipack/ai 的 streamOpenAI / streamAnthropic
 * 处理模型调用，并把 aipack/ai 的流式事件自动转换为框架事件。
 *
 * 注意：StreamFn 入参的 `model` 会被实际使用（而非闭包捕获的 aiModel），
 * 这样 `runtime.setModel(adaptAiModel(otherAiModel))` 才能生效。
 * `adaptAiModel` 会透传 ai 的全部字段（api/baseUrl/cost 等），因此可安全回退为 ai Model。
 *
 * @param aiModel 来自 aipack/ai 的标准化模型（含 api/baseUrl/cost 等元数据）
 * @param options 透传给底层流式实现的选项（apiKey、env、headers、baseUrl 等）
 */
export function createStreamFnFromAi(
  aiModel: AiModel,
  options: SimpleStreamOptions = {},
): StreamFn {
  return async function* (
    model: Model,
    context: Parameters<StreamFn>[1],
    streamOptions?: StreamOptions,
  ): AsyncGenerator<StreamEvent> {
    // 使用 runtime 传入的 model（setModel 后会更新）；其携带 ai 的扩展字段。
    // 回退到闭包 aiModel 以兼容调用方直接传入裸 core Model 的情况。
    const activeModel: AiModel = (model && (model as unknown as AiModel).api)
      ? (model as unknown as AiModel)
      : aiModel;

    // ── 组装 aipack/ai Context ──
    // 框架 Message 与 aipack/ai Message 结构同源，直接映射；
    // 唯一差异：aipack/ai 没有 system 角色消息（systemPrompt 单独传），这里合并。
    const systemParts: string[] = [];
    if (context.systemPrompt) systemParts.push(context.systemPrompt);

    const messages = context.messages.filter(m => {
      if (m.role === 'system') {
        systemParts.push(extractText(m.content));
        return false;
      }
      return true;
    });

    const aiContext: AiContext = {
      systemPrompt: systemParts.join('\n') || undefined,
      messages: messages as unknown as AiMessage[],
      tools: context.tools?.map(t => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters as unknown as TSchema,
      })),
    };

    // ── 合并选项（框架的 AbortSignal / reasoning 透传） ──
    // 注意：stream-openai/anthropic 读取的是 options.reasoning（非 reasoningEffort），
    // 此前误写入 reasoningEffort 导致框架 setThinkingLevel 配置对模型完全无效。
    const merged: AiStreamOptions = { ...options };
    if (streamOptions?.signal) merged.signal = streamOptions.signal;
    if (streamOptions?.reasoning) {
      // 框架 ThinkingLevel（off/minimal/low/.../max）与 AI ReasoningLevel 同域，
      // 运行时值合法；此处类型断言消除联合类型差异
      merged.reasoning = (merged.reasoning ?? streamOptions.reasoning) as ReasoningLevel;
    }
    // 透传重试回调（遥测用），让 runtime 能感知 provider 内部的退避重试
    if (streamOptions?.onRetryAttempt) {
      merged.onRetryAttempt = streamOptions.onRetryAttempt;
    }

    // ── 按 model.api 分派(与 aipack/ai Models.dispatchStream 保持一致) ──
    const stream = hasApi(activeModel, 'anthropic-messages')
      ? streamAnthropic(activeModel, aiContext, merged)
      : streamOpenAI(activeModel, aiContext, merged);

    // ── 事件转换 ──
    // aipack/ai 的 toolcall_start 事件没有 id/name（只有 contentIndex），
    // 因此用 contentIndex 跟踪活跃工具，从 partial 中补齐 id/name。
    const known = new Map<number, AiToolCallContent>();

    for await (const ev of stream as AsyncIterable<AiStreamEvent>) {
      switch (ev.type) {
        case 'start':
          yield {
            type: 'start',
            partial: { content: ev.partial.content as unknown as ContentBlock[] },
          };
          break;

        case 'text_delta':
          yield { type: 'text_delta', delta: ev.delta };
          break;

        case 'thinking_delta':
          yield { type: 'thinking_delta', delta: ev.delta };
          break;

        case 'toolcall_start':
          // 无 id/name，忽略；后续 delta/end 事件会补全
          break;

        case 'toolcall_delta': {
          const tool = findToolCall(ev.partial, ev.contentIndex, known);
          if (tool) {
            if (!known.has(ev.contentIndex)) {
              known.set(ev.contentIndex, tool);
              yield {
                type: 'tool_call_start',
                id: tool.id,
                name: tool.name,
              };
            }
            yield {
              type: 'tool_call_delta',
              id: tool.id,
              delta: ev.delta,
            };
          }
          break;
        }

        case 'toolcall_end': {
          const id = ev.toolCall.id;
          yield { type: 'tool_call_end', id };
          known.delete(ev.contentIndex);
          break;
        }

        case 'done':
          yield {
            type: 'done',
            message: normalizeAssistantMessage(ev.message, ev.reason),
          };
          break;

        case 'error':
          yield {
            type: 'error',
            message: normalizeAssistantMessage(ev.error, 'error'),
          };
          break;
      }
    }
  };
}
