import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { logger } from '../utils/logger.js';
import { getProjectConfigDir } from '../config/paths.js';

export type MediaDirProvider = (channel?: string | null) => string;
export type SignedMediaPath = (absPath: string) => { url: string; name: string } | null;
export type SignedMediaUrl = (absPath: string) => string | null;

const MEDIA_ALLOWED_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/svg+xml',
  'video/mp4',
  'video/webm',
  'video/quicktime',
]);

const SVG_MEDIA_HEADERS: Array<[string, string]> = [
  [
    'Content-Security-Policy',
    "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
  ],
];

const BYTE_RANGE_RE = /^bytes=(\d*)-(\d*)$/;

function getMediaDir(channel?: string | null): string {
  return path.join(getProjectConfigDir(), 'media', channel || 'default');
}

export function b64urlEncode(data: Buffer): string {
  return data.toString('base64url').replace(/=+$/, '');
}

export function b64urlDecode(value: string): Buffer {
  const pad = '='.repeat((4 - (value.length % 4)) % 4);
  return Buffer.from(value + pad, 'base64url');
}

function parseSingleByteRange(rangeHeader: string, size: number): [number, number] {
  if (size <= 0 || rangeHeader.includes(',')) {
    throw new Error('invalid byte range');
  }
  const m = rangeHeader.trim().match(BYTE_RANGE_RE);
  if (!m) {
    throw new Error('invalid byte range');
  }
  const [, startText, endText] = m;
  if (!startText && !endText) {
    throw new Error('invalid byte range');
  }
  let start: number;
  let end: number;
  if (!startText) {
    const suffixLength = parseInt(endText, 10);
    if (suffixLength <= 0) {
      throw new Error('invalid byte range');
    }
    start = Math.max(size - suffixLength, 0);
    end = size - 1;
  } else {
    start = parseInt(startText, 10);
    end = endText ? parseInt(endText, 10) : size - 1;
    if (start >= size || start > end) {
      throw new Error('invalid byte range');
    }
    end = Math.min(end, size - 1);
  }
  return [start, end];
}

export function signMediaPath(
  absPath: string,
  options: {
    secret: Buffer;
    mediaDir?: MediaDirProvider;
  },
): string | null {
  const mediaDir = options.mediaDir || getMediaDir;
  try {
    const mediaRoot = path.resolve(mediaDir(null));
    const resolved = path.resolve(absPath);
    const rel = path.relative(mediaRoot, resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      return null;
    }
    const payload = b64urlEncode(Buffer.from(rel.split(path.sep).join('/'), 'utf-8'));
    const mac = crypto
      .createHmac('sha256', options.secret)
      .update(payload)
      .digest()
      .slice(0, 16);
    return `/api/media/${b64urlEncode(mac)}/${payload}`;
  } catch {
    return null;
  }
}

function safeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 255) || 'file';
}

export function signOrStageMediaPath(
  filePath: string,
  options: {
    secret: Buffer;
    mediaDir?: MediaDirProvider;
  },
): { url: string; name: string } | null {
  const signed = signMediaPath(filePath, options);
  if (signed) {
    return { url: signed, name: path.basename(filePath) };
  }
  try {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      return null;
    }
    const mediaDir = options.mediaDir || getMediaDir;
    const targetDir = mediaDir('websocket');
    fs.mkdirSync(targetDir, { recursive: true });
    const safeName = safeFilename(path.basename(filePath)) || 'attachment';
    const staged = path.join(
      targetDir,
      `${crypto.randomBytes(6).toString('hex')}-${safeName}`,
    );
    fs.copyFileSync(filePath, staged);
    const signedUrl = signMediaPath(staged, options);
    if (!signedUrl) return null;
    return { url: signedUrl, name: path.basename(filePath) };
  } catch (err) {
    logger.warn({ err, path: filePath }, 'failed to stage outbound media');
    return null;
  }
}

export function mediaAttachmentKind(name: string): string {
  const ext = path.extname(name).toLowerCase();
  if (['.mp4', '.webm', '.mov', '.avi', '.mkv'].includes(ext)) {
    return 'video';
  }
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp'].includes(ext)) {
    return 'image';
  }
  return 'file';
}

function guessMimeType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const mimeMap: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
  };
  return mimeMap[ext] || 'application/octet-stream';
}

export function signedMediaAttachments(
  paths: string[],
  signPath: SignedMediaPath,
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const pstr of paths) {
    const att = signPath(pstr);
    if (!att || !att.url) continue;
    const name = att.name || path.basename(pstr);
    out.push({ kind: mediaAttachmentKind(name), url: att.url, name });
  }
  return out;
}

export function attachSignedMediaUrls(
  payload: Record<string, unknown>,
  signPath: SignedMediaUrl,
): void {
  const messages = payload.messages;
  if (!Array.isArray(messages)) return;
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;
    const media = (msg as Record<string, unknown>).media;
    if (!Array.isArray(media) || media.length === 0) continue;
    const urls: Array<{ url: string; name: string }> = [];
    for (const entry of media) {
      if (typeof entry !== 'string' || !entry) continue;
      const signed = signPath(entry);
      if (!signed) continue;
      urls.push({ url: signed, name: path.basename(entry) });
    }
    if (urls.length > 0) {
      (msg as Record<string, unknown>).media_urls = urls;
    }
    delete (msg as Record<string, unknown>).media;
  }
}

export interface ServeSignedMediaResult {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

export function serveSignedMedia(
  sig: string,
  payload: string,
  options: {
    secret: Buffer;
    rangeHeader?: string;
    mediaDir?: MediaDirProvider;
  },
): ServeSignedMediaResult {
  const mediaDir = options.mediaDir || getMediaDir;
  let providedMac: Buffer;
  try {
    providedMac = b64urlDecode(sig);
  } catch {
    return {
      status: 401,
      headers: { 'Content-Type': 'text/plain' },
      body: Buffer.from('invalid signature'),
    };
  }
  const expectedMac = crypto
    .createHmac('sha256', options.secret)
    .update(payload)
    .digest()
    .slice(0, 16);
  if (!crypto.timingSafeEqual(expectedMac, providedMac)) {
    return {
      status: 401,
      headers: { 'Content-Type': 'text/plain' },
      body: Buffer.from('invalid signature'),
    };
  }
  let relStr: string;
  try {
    relStr = b64urlDecode(payload).toString('utf-8');
  } catch {
    return {
      status: 400,
      headers: { 'Content-Type': 'text/plain' },
      body: Buffer.from('invalid payload'),
    };
  }
  let candidate: string;
  try {
    const mediaRoot = path.resolve(mediaDir(null));
    candidate = path.resolve(path.join(mediaRoot, relStr));
    const rel = path.relative(mediaRoot, candidate);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      return {
        status: 404,
        headers: { 'Content-Type': 'text/plain' },
        body: Buffer.from('not found'),
      };
    }
  } catch {
    return {
      status: 404,
      headers: { 'Content-Type': 'text/plain' },
      body: Buffer.from('not found'),
    };
  }
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
    return {
      status: 404,
      headers: { 'Content-Type': 'text/plain' },
      body: Buffer.from('not found'),
    };
  }

  let mime = guessMimeType(candidate);
  if (!MEDIA_ALLOWED_MIMES.has(mime)) {
    mime = 'application/octet-stream';
  }
  const commonHeaders: Record<string, string> = {
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
  };
  if (mime === 'image/svg+xml') {
    for (const [key, value] of SVG_MEDIA_HEADERS) {
      commonHeaders[key] = value;
    }
  }
  let size: number;
  try {
    size = fs.statSync(candidate).size;
  } catch {
    return {
      status: 500,
      headers: { 'Content-Type': 'text/plain' },
      body: Buffer.from('read error'),
    };
  }

  const rangeHeader = options.rangeHeader || '';
  if (rangeHeader) {
    try {
      const [start, end] = parseSingleByteRange(rangeHeader, size);
      const length = end - start + 1;
      let body: Buffer;
      try {
        const fd = fs.openSync(candidate, 'r');
        body = Buffer.alloc(length);
        fs.readSync(fd, body, 0, length, start);
        fs.closeSync(fd);
      } catch {
        return {
          status: 500,
          headers: { 'Content-Type': 'text/plain' },
          body: Buffer.from('read error'),
        };
      }
      return {
        status: 206,
        headers: {
          ...commonHeaders,
          'Content-Type': mime,
          'Content-Range': `bytes ${start}-${end}/${size}`,
        },
        body,
      };
    } catch {
      return {
        status: 416,
        headers: {
          'Accept-Ranges': 'bytes',
          'Content-Range': `bytes */${size}`,
          'X-Content-Type-Options': 'nosniff',
          'Content-Type': 'text/plain',
        },
        body: Buffer.from('range not satisfiable'),
      };
    }
  }

  let body: Buffer;
  try {
    body = fs.readFileSync(candidate);
  } catch {
    return {
      status: 500,
      headers: { 'Content-Type': 'text/plain' },
      body: Buffer.from('read error'),
    };
  }
  return {
    status: 200,
    headers: {
      ...commonHeaders,
      'Content-Type': mime,
    },
    body,
  };
}
