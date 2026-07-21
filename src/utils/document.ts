import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';

const _MAX_TEXT_LENGTH = 200_000;
const _MAX_EXTRACT_FILE_SIZE = 50 * 1024 * 1024;

export const SUPPORTED_EXTENSIONS = new Set([
  '.pdf',
  '.docx',
  '.xlsx',
  '.pptx',
  '.txt',
  '.md',
  '.csv',
  '.json',
  '.xml',
  '.html',
  '.htm',
  '.log',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.cfg',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
]);

class _TextCollector {
  limit: number;
  parts: string[] = [];
  length = 0;
  truncated = false;

  constructor(limit: number) {
    this.limit = limit;
  }

  add(text: string, separator = ''): boolean {
    if (!text) return true;
    const prefix = this.parts.length > 0 ? separator : '';
    const chunk = prefix + text;
    const remaining = this.limit - this.length;
    if (chunk.length > remaining) {
      if (remaining > 0) {
        this.parts.push(chunk.slice(0, remaining));
        this.length += remaining;
      }
      this.truncated = true;
      return false;
    }
    this.parts.push(chunk);
    this.length += chunk.length;
    return true;
  }

  render(): string {
    const text = this.parts.join('');
    if (this.truncated) {
      return text + `... (truncated at ${this.limit} chars)`;
    }
    return text;
  }
}

export function extractText(filePath: string): string | null {
  const p = path.resolve(filePath);

  if (!fs.existsSync(p)) {
    return `[error: file not found: ${filePath}]`;
  }

  try {
    const stat = fs.statSync(p);
    if (stat.size > _MAX_EXTRACT_FILE_SIZE) {
      return `[error: file exceeds ${Math.floor(_MAX_EXTRACT_FILE_SIZE / (1024 * 1024))} MB limit]`;
    }
  } catch (e) {
    return `[error: failed to inspect file: ${String(e)}]`;
  }

  const ext = path.extname(p).toLowerCase();

  if (_isTextExtension(ext)) {
    return _extractTextFile(p);
  }

  if (ext === '.pdf' || ext === '.docx' || ext === '.xlsx' || ext === '.pptx') {
    return `[document: ${path.basename(p)}]`;
  }

  if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) {
    return `[image: ${path.basename(p)}]`;
  }

  return null;
}

function _extractTextFile(filePath: string): string {
  try {
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      content = fs.readFileSync(filePath, 'latin1');
    }
    return _truncate(content, _MAX_TEXT_LENGTH);
  } catch (e) {
    logger.error({ err: e, file_path: filePath }, 'Failed to read text file');
    return `[error: failed to read file: ${String(e)}]`;
  }
}

function _truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(0, maxLength) + `... (truncated, ${text.length} chars total)`;
}

function _isTextExtension(ext: string): boolean {
  return [
    '.txt',
    '.md',
    '.csv',
    '.json',
    '.xml',
    '.html',
    '.htm',
    '.log',
    '.yaml',
    '.yml',
    '.toml',
    '.ini',
    '.cfg',
  ].includes(ext);
}

function _detectImageMime(data: Buffer): string | null {
  if (data.length < 4) return null;
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'image/png';
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38) return 'image/gif';
  if (data.length >= 12 && data.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
}

export function isImageFile(filePath: string): boolean {
  const p = path.resolve(filePath);
  let mime: string | null = null;

  if (fs.existsSync(p) && fs.statSync(p).isFile()) {
    try {
      const fd = fs.openSync(p, 'r');
      const buf = Buffer.alloc(16);
      fs.readSync(fd, buf, 0, 16, 0);
      fs.closeSync(fd);
      mime = _detectImageMime(buf);
    } catch {
      mime = null;
    }
  }

  if (!mime) {
    const ext = path.extname(p).toLowerCase();
    if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) {
      return true;
    }
    return false;
  }

  return mime.startsWith('image/');
}

export function extractDocuments(
  text: string,
  mediaPaths: string[],
  opts: { max_file_size?: number } = {},
): { text: string; imagePaths: string[] } {
  const maxFileSize = opts.max_file_size ?? _MAX_EXTRACT_FILE_SIZE;
  const imagePaths: string[] = [];
  const docTexts: string[] = [];

  for (const pathStr of mediaPaths) {
    const p = path.resolve(pathStr);
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) {
      continue;
    }

    try {
      const size = fs.statSync(p).size;
      if (size > maxFileSize) {
        logger.warn(
          { file: path.basename(p), size_mb: (size / (1024 * 1024)).toFixed(1) },
          'Skipping oversized file for extraction',
        );
        continue;
      }
    } catch {
      continue;
    }

    if (isImageFile(pathStr)) {
      imagePaths.push(pathStr);
    } else {
      const extracted = extractText(p);
      if (extracted && !extracted.startsWith('[error:')) {
        docTexts.push(`[File: ${path.basename(p)}]\n${extracted}`);
      }
    }
  }

  let resultText = text;
  if (docTexts.length > 0) {
    resultText = text + '\n\n' + docTexts.join('\n\n');
  }

  return { text: resultText, imagePaths };
}
