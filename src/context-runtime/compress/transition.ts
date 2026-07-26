/**
 * 过渡消息 - 压缩后的平滑过渡提示
 *
 * 在压缩后添加一条过渡消息，告知模型上下文已被压缩，
 * 帮助模型理解上下文的变化，避免困惑。
 */

import type { AgentMessage } from '../../agent/types';
import type { CompressionLevel, TransitionMessagesConfig } from '../types';
import { createCompactionMessage } from '../state/message-adapter';

/**
 * 创建过渡消息内容
 *
 * @param level 压缩级别
 * @param config 过渡消息配置
 * @param stats 统计数据（可选）
 * @returns 过渡消息文本，未启用则返回 null
 */
export function createTransitionMessage(
  level: CompressionLevel,
  config: TransitionMessagesConfig,
  stats?: { tokensSaved: number; compressionRatio?: number },
): string | null {
  if (!config.enabled) return null;

  let content = '';
  switch (level) {
    case 'clean':
      content = config.l1;
      break;
    case 'window':
      content = config.l2;
      break;
    case 'collapse':
      content = config.l3;
      break;
    case 'snapshot':
      content = config.l4;
      break;
    case 'emergency':
      content = config.l5;
      break;
  }

  // 如果有统计数据，追加到消息末尾
  if (stats && stats.tokensSaved > 0) {
    const percent = stats.compressionRatio ? Math.round(stats.compressionRatio * 100) : 0;
    content = content.replace(/。$/, ` (节省 ~${Math.round(stats.tokensSaved)} tokens${percent > 0 ? `, ${percent}%` : ''})。`);
  }

  return content;
}

/**
 * 创建过渡消息对象（完整的 AgentMessage）
 *
 * @param level 压缩级别
 * @param config 过渡消息配置
 * @param tokensBefore 压缩前 token 数
 * @param stats 统计数据（可选）
 * @returns 过渡消息对象，未启用则返回 null
 */
export function createTransitionMessageObject(
  level: CompressionLevel,
  config: TransitionMessagesConfig,
  tokensBefore: number,
  stats?: { tokensSaved: number; compressionRatio?: number },
): AgentMessage | null {
  const content = createTransitionMessage(level, config, stats);
  if (!content) return null;
  return createCompactionMessage(content, tokensBefore);
}
