import { logger } from '../utils/logger.js';

export interface ChannelValidationResult {
  valid: boolean;
  error?: string;
  details?: Record<string, unknown>;
}

export interface ChannelConfig {
  type: string;
  [key: string]: unknown;
}

const REQUIRED_FIELDS: Record<string, string[]> = {
  slack: ['bot_token'],
  discord: ['bot_token'],
  telegram: ['bot_token'],
  whatsapp: ['account_sid', 'auth_token'],
  email: ['imap_host', 'smtp_host'],
  wecom: ['corp_id', 'agent_id', 'secret'],
  dingtalk: ['app_key', 'app_secret'],
  feishu: ['app_id', 'app_secret'],
  matrix: ['homeserver_url', 'access_token'],
  msteams: ['app_id', 'app_password'],
  mattermost: ['url', 'token'],
  signal: ['phone_number'],
  qq: ['app_id', 'token'],
  weixin: ['app_id', 'app_secret'],
  websocket: [],
  cli: [],
};

export function validateChannelConfig(config: ChannelConfig): ChannelValidationResult {
  const type = config.type;
  if (!type) {
    return { valid: false, error: 'channel type is required' };
  }

  const requiredFields = REQUIRED_FIELDS[type];
  if (!requiredFields) {
    return { valid: false, error: `unknown channel type: ${type}` };
  }

  const missing: string[] = [];
  for (const field of requiredFields) {
    if (!config[field] || config[field] === '') {
      missing.push(field);
    }
  }

  if (missing.length > 0) {
    return {
      valid: false,
      error: `missing required fields: ${missing.join(', ')}`,
      details: { missing_fields: missing },
    };
  }

  return { valid: true };
}

export function validateChannelType(type: string): boolean {
  return Object.prototype.hasOwnProperty.call(REQUIRED_FIELDS, type);
}

export function listChannelTypes(): string[] {
  return Object.keys(REQUIRED_FIELDS).sort();
}
