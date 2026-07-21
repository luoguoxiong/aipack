import { logger } from './logger.js';

export interface MediaInfo {
  mime_type: string;
  size_bytes: number;
  extension: string;
}

export function detectMediaType(base64Data: string): MediaInfo | null {
  const header = base64Data.slice(0, 50).toUpperCase();
  
  const signatures: Record<string, { mime: string; ext: string }> = {
    '/9J/': { mime: 'image/jpeg', ext: '.jpg' },
    'R0lGOD': { mime: 'image/gif', ext: '.gif' },
    'iVBOR': { mime: 'image/png', ext: '.png' },
    'UklGR': { mime: 'image/webp', ext: '.webp' },
    'JVBER': { mime: 'application/pdf', ext: '.pdf' },
    'SUhJ': { mime: 'image/tiff', ext: '.tiff' },
    'AAECAw': { mime: 'image/bmp', ext: '.bmp' },
  };

  for (const [sig, info] of Object.entries(signatures)) {
    if (header.includes(sig)) {
      return {
        mime_type: info.mime,
        size_bytes: Math.round((base64Data.length * 3) / 4),
        extension: info.ext,
      };
    }
  }

  logger.debug({ sample: header }, 'Unknown media type');
  return null;
}

export function decodeBase64ToBuffer(base64Data: string): Buffer {
  const cleanData = base64Data.trim().replace(/^data:[^;]+;base64,/, '');
  return Buffer.from(cleanData, 'base64');
}

export async function decodeMediaFile(opts: {
  base64Data: string;
  outputPath: string;
}): Promise<MediaInfo | null> {
  const info = detectMediaType(opts.base64Data);
  if (!info) {
    return null;
  }

  try {
    const fs = await import('fs');
    const buffer = decodeBase64ToBuffer(opts.base64Data);
    await fs.promises.writeFile(opts.outputPath, buffer);
    return info;
  } catch (err) {
    logger.error({ err, path: opts.outputPath }, 'Failed to decode media file');
    return null;
  }
}

export function isSupportedImageType(mimeType: string): boolean {
  const supported = [
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'image/bmp',
    'image/tiff',
  ];
  return supported.includes(mimeType);
}

export function isSupportedMediaType(mimeType: string): boolean {
  return isSupportedImageType(mimeType) || mimeType === 'application/pdf';
}