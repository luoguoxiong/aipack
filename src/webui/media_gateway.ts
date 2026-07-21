import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { logger } from '../utils/logger.js';
import { getProjectConfigDir } from '../config/paths.js';

export interface MediaItem {
  id: string;
  filename: string;
  content_type: string;
  size: number;
  stored_path: string;
  created_at: string;
  session_key?: string;
}

const MEDIA_DIR = path.join(getProjectConfigDir(), 'webui', 'media');
const SIGNING_SECRET = crypto.randomBytes(32).toString('hex');
const SIGNED_URL_TTL = 60 * 60 * 1000;

function getMediaDir(): string {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  return MEDIA_DIR;
}

function guessContentType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const types: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
  };
  return types[ext] || 'application/octet-stream';
}

export async function saveMedia(
  filename: string,
  data: Buffer,
  sessionKey?: string,
): Promise<MediaItem> {
  const id = crypto.randomBytes(16).toString('hex');
  const ext = path.extname(filename);
  const storedName = `${id}${ext}`;
  const storedPath = path.join(getMediaDir(), storedName);

  fs.writeFileSync(storedPath, data);

  const item: MediaItem = {
    id,
    filename,
    content_type: guessContentType(filename),
    size: data.length,
    stored_path: storedPath,
    created_at: new Date().toISOString(),
    session_key: sessionKey,
  };

  logger.info({ id, filename, sessionKey }, 'Media saved');
  return item;
}

export function getMedia(id: string): MediaItem | null {
  const mediaDir = getMediaDir();
  try {
    const files = fs.readdirSync(mediaDir);
    const found = files.find((f) => f.startsWith(id));
    if (!found) return null;

    const filePath = path.join(mediaDir, found);
    const stat = fs.statSync(filePath);

    return {
      id,
      filename: found,
      content_type: guessContentType(found),
      size: stat.size,
      stored_path: filePath,
      created_at: stat.birthtime.toISOString(),
    };
  } catch (err) {
    logger.warn({ err, id }, 'Failed to get media');
    return null;
  }
}

export function signMediaUrl(mediaPath: string): string {
  const expiresAt = Date.now() + SIGNED_URL_TTL;
  const payload = `${mediaPath}:${expiresAt}`;
  const signature = crypto
    .createHmac('sha256', SIGNING_SECRET)
    .update(payload)
    .digest('hex');
  const token = Buffer.from(
    JSON.stringify({ path: mediaPath, exp: expiresAt, sig: signature }),
  ).toString('base64url');
  return `/api/media/${token}`;
}

export function verifySignedUrl(token: string): {
  valid: boolean;
  path?: string;
} {
  try {
    const data = JSON.parse(Buffer.from(token, 'base64url').toString('utf-8'));
    if (!data.path || !data.exp || !data.sig) {
      return { valid: false };
    }
    if (Date.now() > data.exp) {
      return { valid: false };
    }
    const payload = `${data.path}:${data.exp}`;
    const expectedSig = crypto
      .createHmac('sha256', SIGNING_SECRET)
      .update(payload)
      .digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(data.sig), Buffer.from(expectedSig))) {
      return { valid: false };
    }
    return { valid: true, path: data.path };
  } catch (err) {
    logger.warn({ err }, 'Failed to verify signed URL');
    return { valid: false };
  }
}

export function listMedia(sessionKey?: string): MediaItem[] {
  const mediaDir = getMediaDir();
  try {
    const files = fs.readdirSync(mediaDir);
    const items: MediaItem[] = [];
    for (const file of files) {
      const filePath = path.join(mediaDir, file);
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) continue;
      const id = path.basename(file, path.extname(file));
      items.push({
        id,
        filename: file,
        content_type: guessContentType(file),
        size: stat.size,
        stored_path: filePath,
        created_at: stat.birthtime.toISOString(),
      });
    }
    return items.sort((a, b) => b.created_at.localeCompare(a.created_at));
  } catch (err) {
    logger.warn({ err }, 'Failed to list media');
    return [];
  }
}

export function deleteMedia(id: string): boolean {
  const mediaDir = getMediaDir();
  try {
    const files = fs.readdirSync(mediaDir);
    const found = files.find((f) => f.startsWith(id));
    if (!found) return false;
    fs.unlinkSync(path.join(mediaDir, found));
    logger.info({ id }, 'Media deleted');
    return true;
  } catch (err) {
    logger.warn({ err, id }, 'Failed to delete media');
    return false;
  }
}
