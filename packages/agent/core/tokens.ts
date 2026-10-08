/**
 * core/tokens - token 估算单一实现
 *
 * 粗略估算口径：约 4 字符 / token（对中英文混合近似可用）。
 * 此前 runtime 与 transformer 各自实现同一口径、靠注释维持一致，
 * 改一处漏一处即产生预算漂移；现统一到 core 供各层共用。
 * 不引入 tokenizer 依赖；若需要精确计数，使用方可注入自定义转换器替换。
 */

import type { Message } from './types';

/** 估算文本 token（约 4 字符/token；空串返回 0） */
export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/** 估算单条消息 token（字符串内容直接计数，块内容序列化后计数） */
export function estimateMessageTokens(message: Message): number {
  const content = message.content;
  if (typeof content === 'string') return estimateTextTokens(content);
  try {
    return Math.ceil(JSON.stringify(content ?? []).length / 4);
  } catch {
    return 0;
  }
}
