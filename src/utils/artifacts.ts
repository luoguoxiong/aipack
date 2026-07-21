import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { logger } from './logger.js';
import { getProjectConfigDir } from '../config/paths.js';

const _DATA_IMAGE_RE = /^data:(image\/[A-Za-z0-9.+-]+);base64,(.*)$/s;
const _MIME_EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

export class ArtifactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArtifactError';
  }
}

function _getMediaDir(): string {
  return path.join(getProjectConfigDir(), 'media');
}

function _detectImageMime(data: Buffer): string | null {
  if (data.length < 4) return null;
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'image/png';
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38) return 'image/gif';
  if (data.length >= 12 && data.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
}

export function decodeImageDataUrl(dataUrl: string): { bytes: Buffer; mime: string } {
  const match = _DATA_IMAGE_RE.exec(dataUrl.trim());
  if (!match) {
    throw new ArtifactError('expected a base64 image data URL');
  }

  const declaredMime = match[1];
  const encoded = match[2];

  let raw: Buffer;
  try {
    raw = Buffer.from(encoded, 'base64');
  } catch (err) {
    throw new ArtifactError('invalid base64 image payload');
  }

  const detectedMime = _detectImageMime(raw);
  if (!detectedMime) {
    throw new ArtifactError('unsupported or unrecognized image data');
  }

  return { bytes: raw, mime: detectedMime };
}

function _safeRelativeDir(saveDir: string): string {
  const normalized = saveDir.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!normalized) {
    throw new ArtifactError('save_dir must not be empty');
  }
  const parts = normalized.split('/');
  if (parts.some(part => part === '' || part === '.' || part === '..')) {
    throw new ArtifactError('save_dir must be a safe relative path');
  }
  return path.join(...parts);
}

function _artifactRoot(saveDir: string): string {
  const mediaRoot = fs.realpathSync(_getMediaDir());
  const root = fs.realpathSync(path.join(mediaRoot, _safeRelativeDir(saveDir)));
  if (!root.startsWith(mediaRoot)) {
    throw new ArtifactError('artifact directory escapes media root');
  }
  return root;
}

function _ensureDir(dirPath: string): string {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

export function storeGeneratedImageArtifact(opts: {
  data_url: string;
  prompt: string;
  model: string;
  source_images?: string[];
  save_dir?: string;
  provider?: string;
  created_at?: Date;
}): Record<string, unknown> {
  const { bytes, mime } = decodeImageDataUrl(opts.data_url);
  const ext = _MIME_EXTENSIONS[mime];
  if (!ext) {
    throw new ArtifactError(`unsupported image MIME type: ${mime}`);
  }

  const now = opts.created_at || new Date();
  const saveDir = opts.save_dir || 'generated';
  const dayDir = _ensureDir(path.join(_artifactRoot(saveDir), now.toISOString().slice(0, 10)));
  const artifactId = `img_${crypto.randomBytes(6).toString('hex')}`;
  const imagePath = path.join(dayDir, `${artifactId}${ext}`);
  const metadataPath = path.join(dayDir, `${artifactId}.json`);

  fs.writeFileSync(imagePath, bytes);

  const metadata: Record<string, unknown> = {
    id: artifactId,
    path: imagePath,
    mime,
    prompt: opts.prompt,
    model: opts.model,
    provider: opts.provider || 'openrouter',
    source_images: opts.source_images || [],
    created_at: now.toISOString(),
  };

  fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), 'utf-8');
  return metadata;
}

export function generatedImageToolResult(artifacts: Record<string, unknown>[]): string {
  return JSON.stringify({
    artifacts,
    next_step:
      'Use these artifact paths as reference_images for follow-up edits. ' +
      'Call the message tool with the artifact paths in the media parameter ' +
      'to deliver the images to the user. Keep raw paths internal unless the ' +
      'user asks for debug details.',
  });
}
