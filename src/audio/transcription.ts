import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger.js';
import { getProjectConfigDir } from '../config/paths.js';
import {
  getTranscriptionProvider,
  resolveTranscriptionProvider,
  type TranscriptionProviderSpec,
} from './transcription_registry.js';

export type TranscriptionProviderName = string;

const _DEFAULT_PROVIDER: TranscriptionProviderName = 'groq';
const _MAX_AUDIO_BYTES_FALLBACK = 25 * 1024 * 1024;
const _AUDIO_MIME_ALLOWED = new Set([
  'audio/aac',
  'audio/flac',
  'audio/m4a',
  'audio/mp4',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'audio/webm',
  'audio/x-m4a',
  'audio/x-wav',
]);

export interface EffectiveTranscriptionConfig {
  enabled: boolean;
  provider: TranscriptionProviderName;
  model: string;
  language: string | null;
  api_key: string;
  api_base: string;
  max_duration_sec: number;
  max_upload_mb: number;
}

export function isTranscriptionConfigured(config: EffectiveTranscriptionConfig): boolean {
  return Boolean(config.api_key);
}

export class TranscriptionIngressError extends Error {
  detail: string;
  extra: Record<string, unknown>;

  constructor(detail: string, extra: Record<string, unknown> = {}) {
    super(detail);
    this.name = 'TranscriptionIngressError';
    this.detail = detail;
    this.extra = extra;
  }
}

function _asProvider(value: unknown): TranscriptionProviderName | null {
  const spec = resolveTranscriptionProvider(value);
  return spec ? spec.name : null;
}

function _extractDataUrlMime(url: string): string | null {
  const header = url.split(',')[0];
  if (!header.startsWith('data:') || !header.includes(';base64')) {
    return null;
  }
  const mimePart = header.slice(5).split(';')[0];
  return mimePart ? mimePart.trim().toLowerCase() : null;
}

function _getMediaDir(subdir = ''): string {
  const base = path.join(getProjectConfigDir(), 'media');
  return subdir ? path.join(base, subdir) : base;
}

function _saveBase64DataUrl(dataUrl: string, dir: string, maxBytes: number): string {
  const match = dataUrl.match(/^data:([^;]+);base64,(.*)$/s);
  if (!match) {
    throw new Error('Invalid data URL');
  }
  const [, , encoded] = match;
  const buffer = Buffer.from(encoded, 'base64');
  if (buffer.length > maxBytes) {
    throw new Error('File size exceeded');
  }
  fs.mkdirSync(dir, { recursive: true });
  const fileName = `audio_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.bin`;
  const filePath = path.join(dir, fileName);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

export function resolveTranscriptionConfig(config: Record<string, unknown>): EffectiveTranscriptionConfig {
  const top = (config['transcription'] || {}) as Record<string, unknown>;
  const channels = (config['channels'] || {}) as Record<string, unknown>;

  let provider =
    _asProvider(top['provider']) ||
    _asProvider(channels['transcription_provider']) ||
    _DEFAULT_PROVIDER;

  let spec: TranscriptionProviderSpec | undefined = getTranscriptionProvider(provider);
  if (!spec) {
    logger.warn({ provider }, 'Unknown transcription provider; falling back to default');
    provider = _DEFAULT_PROVIDER;
    spec = getTranscriptionProvider(provider);
  }

  const defaultModel = spec?.default_model || '';
  const providers = (config['providers'] || {}) as Record<string, Record<string, unknown>>;
  const providerCfg = providers[provider] || {};

  const apiKey = _resolveTranscriptionApiKey(provider, providerCfg);
  const apiBase = _resolveTranscriptionApiBase(provider, providerCfg);

  return {
    enabled: Boolean(top['enabled'] ?? true),
    provider,
    model: (String(top['model'] || '') || defaultModel).trim(),
    language: (top['language'] as string) || (channels['transcription_language'] as string) || null,
    api_key: apiKey,
    api_base: apiBase,
    max_duration_sec: Number(top['max_duration_sec'] ?? 120),
    max_upload_mb: Number(top['max_upload_mb'] ?? 25),
  };
}

function _resolveTranscriptionApiKey(provider: string, providerCfg: Record<string, unknown>): string {
  const apiKey = providerCfg['api_key'];
  if (apiKey && typeof apiKey === 'string') {
    return apiKey;
  }

  if (provider === 'siliconflow') {
    const envKey = process.env['SILICONFLOW_API_KEY'];
    if (envKey) {
      return envKey;
    }
  }

  const envVarMap: Record<string, string> = {
    groq: 'GROQ_API_KEY',
    openai: 'OPENAI_API_KEY',
    openrouter: 'OPENROUTER_API_KEY',
  };

  const envVar = envVarMap[provider];
  return envVar ? process.env[envVar] || '' : '';
}

function _resolveTranscriptionApiBase(provider: string, providerCfg: Record<string, unknown>): string {
  const apiBase = providerCfg['api_base'];
  if (apiBase && typeof apiBase === 'string') {
    return apiBase;
  }
  return '';
}

export async function transcribeAudioDataUrl(
  dataUrl: unknown,
  config: EffectiveTranscriptionConfig,
  opts: { duration_ms?: number } = {},
): Promise<string> {
  if (typeof dataUrl !== 'string' || !dataUrl) {
    throw new TranscriptionIngressError('missing_audio');
  }
  if (!config.enabled) {
    throw new TranscriptionIngressError('disabled');
  }
  if (!isTranscriptionConfigured(config)) {
    throw new TranscriptionIngressError('not_configured', { provider: config.provider });
  }
  if (
    typeof opts.duration_ms === 'number' &&
    opts.duration_ms > config.max_duration_sec * 1000 + 1000
  ) {
    throw new TranscriptionIngressError('duration');
  }
  const mime = _extractDataUrlMime(dataUrl);
  if (!mime || !_AUDIO_MIME_ALLOWED.has(mime)) {
    throw new TranscriptionIngressError('mime');
  }

  let audioPath: string | null = null;
  const maxBytes = Math.max(
    1,
    config.max_upload_mb * 1024 * 1024 || _MAX_AUDIO_BYTES_FALLBACK,
  );

  try {
    audioPath = _saveBase64DataUrl(dataUrl, _getMediaDir('webui-transcription'), maxBytes);
  } catch {
    throw new TranscriptionIngressError('size');
  }

  try {
    const text = await transcribeAudioFile(audioPath, config);
    if (!text) {
      throw new TranscriptionIngressError('empty');
    }
    return text;
  } finally {
    try {
      if (audioPath) {
        fs.unlinkSync(audioPath);
      }
    } catch {
      // best effort
    }
  }
}

export async function transcribeAudioFile(
  filePath: string,
  config: EffectiveTranscriptionConfig,
): Promise<string> {
  if (!config.enabled || !isTranscriptionConfigured(config)) {
    return '';
  }

  const spec = getTranscriptionProvider(config.provider);
  if (!spec) {
    logger.warn({ provider: config.provider }, 'Unknown transcription provider');
    return '';
  }

  // In this TS port, we don't dynamically load adapters; this is a stub.
  // Real implementations would use the provider adapter pattern.
  logger.warn({ provider: config.provider }, 'Transcription adapter not implemented in TS port yet');
  return '';
}
