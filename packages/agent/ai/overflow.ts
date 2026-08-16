/**
 * 上下文溢出检测
 *
 * 通过匹配各提供商的错误消息模式，检测 API 返回是否因输入超出上下文窗口导致。
 * 支持三种溢出模式：
 * 1. 显式溢出：provider 返回错误消息
 * 2. 静默溢出：provider 接受请求但 usage.input > contextWindow
 * 3. 截断溢出：provider 截断输入并返回 stopReason="length" + output=0
 */

// ─── 溢出模式 ──────────────────────────────────────────────────────

const OVERFLOW_PATTERNS: RegExp[] = [
  // 本框架 formatCategoryError 产出的分类前缀（errors.ts），
  // 覆盖消息体不含已知关键词但已带分类前缀的场景
  /^\[context-overflow\]/i,
  // Anthropic
  /prompt is too long/i,
  /request_too_large/i,
  // Amazon Bedrock
  /input is too long for requested model/i,
  // OpenAI & 兼容
  /exceeds the context window/i,
  /exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))/i,
  /input token count.*exceeds the maximum/i,
  // xAI Grok
  /maximum prompt length is \d+/i,
  // Groq
  /reduce the length of the messages/i,
  // OpenRouter
  /maximum context length is \d+ tokens/i,
  /exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?/i,
  // Together AI
  /input \(\d+ tokens\) is longer than the model'?s context length \(\d+ tokens\)/i,
  // GitHub Copilot
  /exceeds the limit of \d+/i,
  // llama.cpp
  /exceeds the available context size/i,
  // LM Studio
  /greater than the context length/i,
  // MiniMax
  /context window exceeds limit/i,
  // Kimi
  /exceeded model token limit/i,
  // Mistral
  /too large for model with \d+ maximum context length/i,
  // DS4
  /prompt has [\d,]+ tokens?, but the configured context size is [\d,]+ tokens?/i,
  // z.ai
  /model_context_window_exceeded/i,
  // Ollama
  /prompt too long; exceeded (?:max )?context length/i,
  // DashScope / Qwen
  /range of input length should be/i,
  // 通用回退
  /context[_ ]length[_ ]exceeded/i,
  /too many tokens/i,
  /token limit exceeded/i,
  // Cerebras: 400/413 无 body
  /^4(?:00|13)\s*(?:status code)?\s*\(no body\)/i,
];

// ─── 非溢出的排除模式 ─────────────────────────────────────────────

const NON_OVERFLOW_PATTERNS: RegExp[] = [
  /^(Throttling error|Service unavailable):/i,
  /rate limit/i,
  /too many requests/i,
];

// ─── 导出函数 ──────────────────────────────────────────────────────

/**
 * 溢出检测所需的消息最小形状。
 * 兼容 core（stopReason/usage 可缺省）与 ai（必填）两套 AssistantMessage 定义。
 */
export interface OverflowProbeMessage {
  stopReason?: string;
  errorMessage?: string;
  usage?: {
    input: number;
    output: number;
    cacheRead?: number;
  };
}

/**
 * 判断一条 assistant message 是否为上下文溢出错误。
 *
 * @param message - 要检查的 assistant message
 * @param contextWindow - 可选的上下文窗口大小，用于检测静默溢出（如 z.ai）
 */
export function isContextOverflow(
  message: OverflowProbeMessage,
  contextWindow?: number,
): boolean {
  // 情况 1：检查错误消息模式（显式溢出）
  if (message.stopReason === 'error' && message.errorMessage) {
    const errMsg: string = message.errorMessage;
    const isNonOverflow = NON_OVERFLOW_PATTERNS.some((p) => p.test(errMsg));
    if (!isNonOverflow && OVERFLOW_PATTERNS.some((p) => p.test(errMsg))) {
      return true;
    }
  }

  // 情况 2：静默溢出（z.ai 风格）— 成功但 usage 超出上下文
  if (contextWindow && message.stopReason === 'stop' && message.usage) {
    const inputTokens = message.usage.input + (message.usage.cacheRead ?? 0);
    if (inputTokens > contextWindow) {
      return true;
    }
  }

  // 情况 3：截断溢出（小米 MiMo 风格）— 截断输入后无输出空间
  if (
    contextWindow &&
    message.stopReason === 'length' &&
    message.usage &&
    message.usage.output === 0
  ) {
    const inputTokens = message.usage.input + (message.usage.cacheRead ?? 0);
    if (inputTokens >= contextWindow * 0.99) {
      return true;
    }
  }

  return false;
}

/**
 * 获取溢出模式列表（用于测试）
 */
export function getOverflowPatterns(): RegExp[] {
  return [...OVERFLOW_PATTERNS];
}
