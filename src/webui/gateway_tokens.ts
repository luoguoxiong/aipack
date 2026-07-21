import crypto from 'crypto';
import { logger } from '../utils/logger.js';

export interface GatewayToken {
  id: string;
  name: string;
  token_prefix: string;
  created_at: string;
  last_used_at?: string;
  expires_at?: string;
  scopes: string[];
}

export class GatewayTokensManager {
  private tokens: Map<string, GatewayToken & { token_hash: string }> = new Map();

  create(options: {
    name: string;
    scopes?: string[];
    expiresAt?: string;
  }): { token: string; info: GatewayToken } {
    const id = `token_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const token = `nb_${crypto.randomBytes(32).toString('hex')}`;
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const now = new Date().toISOString();
    const tokenPrefix = token.slice(0, 8);

    const tokenInfo: GatewayToken = {
      id,
      name: options.name,
      token_prefix: tokenPrefix,
      created_at: now,
      scopes: options.scopes || ['*'],
      expires_at: options.expiresAt,
    };

    this.tokens.set(id, { ...tokenInfo, token_hash: tokenHash });
    logger.info({ tokenId: id, name: options.name }, 'Gateway token created');
    return { token, info: tokenInfo };
  }

  list(): GatewayToken[] {
    return Array.from(this.tokens.values())
      .map(({ token_hash: _th, ...rest }) => rest)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  revoke(id: string): boolean {
    const deleted = this.tokens.delete(id);
    if (deleted) {
      logger.info({ tokenId: id }, 'Gateway token revoked');
    }
    return deleted;
  }

  validate(token: string): GatewayToken | null {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    for (const t of this.tokens.values()) {
      if (t.token_hash === tokenHash) {
        t.last_used_at = new Date().toISOString();
        const { token_hash: _th, ...rest } = t;
        return rest;
      }
    }
    return null;
  }
}
