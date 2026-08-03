/**
 * packages/request - 请求入口
 *
 * 独立实现，不依赖 src/。
 * 负责请求的解析、验证与标准化。
 */

import { RequestBuilder, createRequest } from '../core';
import type { Request, RequestType } from '../core';

// ─── 请求验证 ─────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateRequest(request: Request): ValidationResult {
  const errors: string[] = [];

  if (!request.message || request.message.trim().length === 0) {
    errors.push('message 不能为空');
  }

  if (!request.sessionKey || request.sessionKey.trim().length === 0) {
    errors.push('sessionKey 不能为空');
  }

  if (request.message.length > 100000) {
    errors.push('message 长度超过限制（100000 字符）');
  }

  return { valid: errors.length === 0, errors };
}

// ─── 请求标准化 ───────────────────────────────────────────────────

export function normalizeRequest(request: Request): Request {
  return createRequest(request.message, {
    type: request.type,
    sessionKey: request.sessionKey || 'default',
    channel: request.channel || 'cli',
    chatId: request.chatId || 'direct',
    senderId: request.senderId || 'user',
    media: request.media?.filter(Boolean) || [],
    ephemeral: request.ephemeral ?? false,
    model: request.model || undefined,
    modelPreset: request.modelPreset || undefined,
    metadata: request.metadata || {},
  });
}

// ─── 请求工厂 ─────────────────────────────────────────────────────

// 渠道相关工厂（CLI / Webhook / 飞书 / SDK）不属于框架：
// 各渠道由使用方基于 createRequest 自行拼装，例如：
//   createRequest(msg, { sessionKey: `webhook:${chatId}`, channel: 'webhook', chatId, senderId })

export { RequestBuilder, createRequest } from '../core';
export type { Request, RequestType } from '../core';
