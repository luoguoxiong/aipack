import { logger } from '../utils/logger.js';

export interface IngressPolicy {
  maxAttachmentSize: number;
  allowedContentTypes: string[];
  deniedContentTypes: string[];
  rateLimitPerMinute: number;
  autoApprove: boolean;
  requireAuthentication: boolean;
}

const DEFAULT_POLICY: IngressPolicy = {
  maxAttachmentSize: 20 * 1024 * 1024,
  allowedContentTypes: [],
  deniedContentTypes: [],
  rateLimitPerMinute: 60,
  autoApprove: true,
  requireAuthentication: true,
};

let currentPolicy: IngressPolicy = { ...DEFAULT_POLICY };

const rateLimitStore: Map<string, { count: number; windowStart: number }> = new Map();

export function getIngressPolicy(): IngressPolicy {
  return { ...currentPolicy };
}

export function setIngressPolicy(policy: Partial<IngressPolicy>): IngressPolicy {
  currentPolicy = { ...currentPolicy, ...policy };
  logger.info({ policy: currentPolicy }, 'Ingress policy updated');
  return { ...currentPolicy };
}

export function validateAttachment(
  contentType: string,
  size: number,
): { valid: boolean; reason?: string } {
  const policy = getIngressPolicy();

  if (size > policy.maxAttachmentSize) {
    return {
      valid: false,
      reason: `File too large. Maximum size is ${policy.maxAttachmentSize / (1024 * 1024)}MB`,
    };
  }

  if (policy.deniedContentTypes.length > 0) {
    for (const denied of policy.deniedContentTypes) {
      if (contentType.startsWith(denied) || contentType === denied) {
        return { valid: false, reason: `Content type not allowed: ${contentType}` };
      }
    }
  }

  if (policy.allowedContentTypes.length > 0) {
    let allowed = false;
    for (const allow of policy.allowedContentTypes) {
      if (contentType.startsWith(allow) || contentType === allow) {
        allowed = true;
        break;
      }
    }
    if (!allowed) {
      return { valid: false, reason: `Content type not allowed: ${contentType}` };
    }
  }

  return { valid: true };
}

export function checkRateLimit(clientId: string): {
  allowed: boolean;
  remaining: number;
  resetAt: number;
} {
  const policy = getIngressPolicy();
  const now = Date.now();
  const windowMs = 60 * 1000;

  let entry = rateLimitStore.get(clientId);
  if (!entry || now - entry.windowStart >= windowMs) {
    entry = { count: 0, windowStart: now };
    rateLimitStore.set(clientId, entry);
  }

  entry.count++;
  const remaining = Math.max(0, policy.rateLimitPerMinute - entry.count);
  const resetAt = entry.windowStart + windowMs;

  return {
    allowed: entry.count <= policy.rateLimitPerMinute,
    remaining,
    resetAt,
  };
}
