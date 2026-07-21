import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { logger } from '../utils/logger.js';
import { getProjectConfigDir } from '../config/paths.js';

export interface IngressAttachment {
  id: string;
  name: string;
  size: number;
  content_type: string;
  stored_path: string;
  uploaded_at: string;
}

const MAX_ATTACHMENT_SIZE = 20 * 1024 * 1024;

function getIngressDir(): string {
  return path.join(getProjectConfigDir(), 'webui', 'attachments');
}

function safeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 255) || 'file';
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
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.json': 'application/json',
    '.zip': 'application/zip',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
  };
  return types[ext] || 'application/octet-stream';
}

export async function saveAttachment(
  filename: string,
  data: Buffer,
): Promise<IngressAttachment> {
  if (data.length > MAX_ATTACHMENT_SIZE) {
    throw new Error(
      `File too large. Maximum size is ${MAX_ATTACHMENT_SIZE / (1024 * 1024)}MB`,
    );
  }

  const ingressDir = getIngressDir();
  fs.mkdirSync(ingressDir, { recursive: true });

  const id = crypto.randomBytes(16).toString('hex');
  const safeName = safeFilename(filename);
  const storedName = `${id}_${safeName}`;
  const storedPath = path.join(ingressDir, storedName);

  fs.writeFileSync(storedPath, data);

  const attachment: IngressAttachment = {
    id,
    name: filename,
    size: data.length,
    content_type: guessContentType(filename),
    stored_path: storedPath,
    uploaded_at: new Date().toISOString(),
  };

  logger.info({ id, name: filename, size: data.length }, 'Attachment saved');
  return attachment;
}

export function getAttachment(id: string): IngressAttachment | null {
  const ingressDir = getIngressDir();
  try {
    const files = fs.readdirSync(ingressDir);
    const found = files.find((f) => f.startsWith(`${id}_`));
    if (!found) return null;

    const filePath = path.join(ingressDir, found);
    const stat = fs.statSync(filePath);
    const originalName = found.slice(id.length + 1);

    return {
      id,
      name: originalName,
      size: stat.size,
      content_type: guessContentType(originalName),
      stored_path: filePath,
      uploaded_at: stat.birthtime.toISOString(),
    };
  } catch (err) {
    logger.warn({ err, id }, 'Failed to get attachment');
    return null;
  }
}

export function deleteAttachment(id: string): boolean {
  const ingressDir = getIngressDir();
  try {
    const files = fs.readdirSync(ingressDir);
    const found = files.find((f) => f.startsWith(`${id}_`));
    if (!found) return false;

    const filePath = path.join(ingressDir, found);
    fs.unlinkSync(filePath);
    logger.info({ id }, 'Attachment deleted');
    return true;
  } catch (err) {
    logger.warn({ err, id }, 'Failed to delete attachment');
    return false;
  }
}
