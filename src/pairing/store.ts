import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { logger } from '../utils/logger.js';
import { getProjectConfigDir } from '../config/paths.js';

const _ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const _CODE_LENGTH = 8;
const _TTL_DEFAULT_S = 600;

function _storePath(): string {
  return path.join(getProjectConfigDir(), 'pairing.json');
}

interface PairingData {
  approved: Record<string, Set<string>>;
  pending: Record<string, {
    channel: string;
    sender_id: string;
    created_at: number;
    expires_at: number;
  }>;
}

function _load(): PairingData {
  const storePath = _storePath();
  try {
    const data = JSON.parse(fs.readFileSync(storePath, 'utf-8'));
    const approved: Record<string, Set<string>> = {};
    for (const [channel, users] of Object.entries(data.approved || {})) {
      approved[channel] = new Set((users as string[]).map(u => String(u)));
    }
    return {
      approved,
      pending: data.pending || {},
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { approved: {}, pending: {} };
    }
    logger.warn('Corrupted pairing store, resetting');
    return { approved: {}, pending: {} };
  }
}

function _save(data: PairingData): void {
  const storePath = _storePath();
  const dir = path.dirname(storePath);
  fs.mkdirSync(dir, { recursive: true });

  const approved: Record<string, string[]> = {};
  for (const [channel, users] of Object.entries(data.approved)) {
    approved[channel] = Array.from(users).sort();
  }

  const payload = {
    approved,
    pending: data.pending,
  };

  const tmpPath = path.join(dir, `.pairing.json.${crypto.randomBytes(8).toString('hex')}.tmp`);
  fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf-8');
  fs.renameSync(tmpPath, storePath);
}

function _gcPending(data: PairingData): void {
  const now = Date.now() / 1000;
  const pending = data.pending;
  const expired: string[] = [];
  for (const [code, info] of Object.entries(pending)) {
    if (info.expires_at < now) {
      expired.push(code);
    }
  }
  for (const code of expired) {
    delete pending[code];
  }
}

export function generateCode(channel: string, senderId: string, ttl: number = _TTL_DEFAULT_S): string {
  const data = _load();
  _gcPending(data);

  let raw = '';
  for (let i = 0; i < _CODE_LENGTH; i++) {
    raw += _ALPHABET[Math.floor(Math.random() * _ALPHABET.length)];
  }
  const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;

  const now = Date.now() / 1000;
  data.pending[code] = {
    channel,
    sender_id: String(senderId),
    created_at: now,
    expires_at: now + ttl,
  };

  _save(data);
  logger.info({ code, sender_id: senderId, channel }, 'Generated pairing code');
  return code;
}

export function approveCode(code: string): [string, string] | null {
  const data = _load();
  _gcPending(data);

  const info = data.pending[code];
  if (!info) {
    return null;
  }

  delete data.pending[code];
  const channel = info.channel;
  const senderId = info.sender_id;

  if (!data.approved[channel]) {
    data.approved[channel] = new Set();
  }
  data.approved[channel].add(senderId);

  _save(data);
  logger.info({ code, sender_id: senderId, channel }, 'Approved pairing code');
  return [channel, senderId];
}

export function denyCode(code: string): boolean {
  const data = _load();
  _gcPending(data);

  if (code in data.pending) {
    delete data.pending[code];
    _save(data);
    logger.info({ code }, 'Denied pairing code');
    return true;
  }
  return false;
}

export function isApproved(channel: string, senderId: string): boolean {
  const data = _load();
  const users = data.approved[channel];
  return users ? users.has(String(senderId)) : false;
}

export function listPending(): Array<{
  code: string;
  channel: string;
  sender_id: string;
  created_at: number;
  expires_at: number;
}> {
  const data = _load();
  _gcPending(data);
  return Object.entries(data.pending).map(([code, info]) => ({
    code,
    ...info,
  }));
}

export function revoke(channel: string, senderId: string): boolean {
  const data = _load();
  const users = data.approved[channel];
  const sid = String(senderId);
  if (users && users.has(sid)) {
    users.delete(sid);
    if (users.size === 0) {
      delete data.approved[channel];
    }
    _save(data);
    logger.info({ sender_id: sid, channel }, 'Revoked pairing');
    return true;
  }
  return false;
}

export function revokeChannel(channel: string): number {
  const data = _load();
  const users = data.approved[channel];
  if (!users || users.size === 0) {
    return 0;
  }
  const count = users.size;
  delete data.approved[channel];
  _save(data);
  logger.info({ count, channel }, 'Revoked all approved senders from channel');
  return count;
}

export function clearChannel(channel: string): { approved: number; pending: number } {
  const data = _load();

  const approvedUsers = data.approved[channel];
  const approvedCount = approvedUsers ? approvedUsers.size : 0;
  if (approvedUsers) {
    delete data.approved[channel];
  }

  const pendingCodes: string[] = [];
  for (const [code, info] of Object.entries(data.pending)) {
    if (info.channel === channel) {
      pendingCodes.push(code);
    }
  }
  for (const code of pendingCodes) {
    delete data.pending[code];
  }

  if (approvedCount === 0 && pendingCodes.length === 0) {
    return { approved: 0, pending: 0 };
  }

  _save(data);
  logger.info(
    { approved: approvedCount, pending: pendingCodes.length, channel },
    'Cleared pairing data for channel',
  );
  return { approved: approvedCount, pending: pendingCodes.length };
}

export function getApproved(channel: string): string[] {
  const data = _load();
  const users = data.approved[channel];
  return users ? Array.from(users).sort() : [];
}

export function formatPairingReply(code: string): string {
  return (
    'Hi there! This assistant only responds to approved users.\n\n' +
    `Your pairing code is: \`${code}\`\n\n` +
    'To get access, ask the owner to approve this request in the nanobot WebUI.\n' +
    `If the WebUI is not available, the owner can also send \`/pairing approve ${code}\`.`
  );
}

export function formatExpiry(expiresAt: number): string {
  const remaining = Math.floor(expiresAt - Date.now() / 1000);
  return remaining > 0 ? `${remaining}s` : 'expired';
}

export function handlePairingCommand(channel: string, subcommandText: string): string {
  const parts = subcommandText.split(/\s+/);
  const sub = parts[0] || 'list';
  const arg = parts[1];

  if (sub === 'list') {
    const pending = listPending();
    if (pending.length === 0) {
      return 'No pending pairing requests.';
    }
    const lines = ['Pending pairing requests:'];
    for (const item of pending) {
      const expiry = formatExpiry(item.expires_at);
      lines.push(`- \`${item.code}\` | ${item.channel} | ${item.sender_id} | ${expiry}`);
    }
    return lines.join('\n');
  }

  if (sub === 'approve') {
    if (!arg) {
      return 'Usage: `/pairing approve <code>`';
    }
    const result = approveCode(arg);
    if (!result) {
      return `Invalid or expired pairing code: \`${arg}\``;
    }
    const [ch, sid] = result;
    return `Approved pairing code \`${arg}\` — ${sid} can now access ${ch}`;
  }

  if (sub === 'deny') {
    if (!arg) {
      return 'Usage: `/pairing deny <code>`';
    }
    if (denyCode(arg)) {
      return `Denied pairing code \`${arg}\``;
    }
    return `Pairing code \`${arg}\` not found or already expired`;
  }

  if (sub === 'revoke') {
    if (parts.length === 2) {
      return revoke(channel, arg)
        ? `Revoked ${arg} from ${channel}`
        : `${arg} was not in the approved list for ${channel}`;
    }
    if (parts.length === 3) {
      const ch = parts[1];
      const sid = parts[2];
      return revoke(ch, sid)
        ? `Revoked ${sid} from ${ch}`
        : `${sid} was not in the approved list for ${ch}`;
    }
    return 'Usage: `/pairing revoke <user_id>` or `/pairing revoke <channel> <user_id>`';
  }

  return (
    'Unknown pairing command.\n' +
    'Usage: `/pairing [list|approve <code>|deny <code>|revoke <user_id>|revoke <channel> <user_id>]`'
  );
}

export const PAIRING_CODE_META_KEY = '_pairing_code';
export const PAIRING_COMMAND_META_KEY = '_pairing_command';
