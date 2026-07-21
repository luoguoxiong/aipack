import { logger } from '../utils/logger.js';
import axios, { AxiosInstance } from 'axios';

export interface TranscriptionResponse {
  text: string;
  language?: string;
  duration?: number;
  segments?: Array<{
    id: number;
    start: number;
    end: number;
    text: string;
  }>;
}

export interface TranslationResponse {
  text: string;
  duration?: number;
}

export interface TranscriptionProviderConfig {
  name: string;
  api_key?: string;
  base_url?: string;
  default_model?: string;
  extra_headers?: Record<string, string>;
}

export class TranscriptionProvider {
  name = 'transcription';
  private client: AxiosInstance;
  private config: TranscriptionProviderConfig;
  defaultModel: string;

  constructor(config: TranscriptionProviderConfig) {
    this.config = config;
    this.name = config.name || 'transcription';
    this.defaultModel = config.default_model || 'whisper-1';

    const baseURL = this.normalizeBaseUrl(config.base_url || 'https://api.openai.com/v1');
    const headers: Record<string, string> = {
      ...config.extra_headers,
    };

    if (config.api_key) {
      headers['Authorization'] = `Bearer ${config.api_key}`;
    }

    this.client = axios.create({ baseURL, headers });
  }

  private normalizeBaseUrl(apiBase: string): string {
    const normalized = apiBase.replace(/\/+$/, '');
    if (normalized.endsWith('/v1')) {
      return normalized;
    }
    return normalized + '/v1';
  }

  private static stripPrefix(model: string): string {
    if (model.startsWith('openai/')) {
      return model.slice('openai/'.length);
    }
    return model;
  }

  async transcribe(
    audioBuffer: Buffer,
    filename: string,
    options?: {
      model?: string;
      language?: string;
      prompt?: string;
      response_format?: string;
      temperature?: number;
      timestamp_granularities?: string[];
    },
  ): Promise<TranscriptionResponse> {
    const model = TranscriptionProvider.stripPrefix(options?.model || this.defaultModel);

    try {
      const formData = new FormData();
      formData.append('model', model);
      formData.append('file', new Blob([audioBuffer]), filename);

      if (options?.language) {
        formData.append('language', options.language);
      }
      if (options?.prompt) {
        formData.append('prompt', options.prompt);
      }
      if (options?.response_format) {
        formData.append('response_format', options.response_format);
      }
      if (options?.temperature !== undefined) {
        formData.append('temperature', String(options.temperature));
      }
      if (options?.timestamp_granularities) {
        for (const g of options.timestamp_granularities) {
          formData.append('timestamp_granularities[]', g);
        }
      }

      const response = await this.client.post('/audio/transcriptions', formData, {
        headers: {
          'Content-Type': 'multipart/form-data',
        },
      });
      return response.data as TranscriptionResponse;
    } catch (err) {
      logger.error({ err }, 'Transcription request failed');
      throw err;
    }
  }

  async translate(
    audioBuffer: Buffer,
    filename: string,
    options?: {
      model?: string;
      prompt?: string;
      response_format?: string;
      temperature?: number;
    },
  ): Promise<TranslationResponse> {
    const model = TranscriptionProvider.stripPrefix(options?.model || this.defaultModel);

    try {
      const formData = new FormData();
      formData.append('model', model);
      formData.append('file', new Blob([audioBuffer]), filename);

      if (options?.prompt) {
        formData.append('prompt', options.prompt);
      }
      if (options?.response_format) {
        formData.append('response_format', options.response_format);
      }
      if (options?.temperature !== undefined) {
        formData.append('temperature', String(options.temperature));
      }

      const response = await this.client.post('/audio/translations', formData, {
        headers: {
          'Content-Type': 'multipart/form-data',
        },
      });
      return response.data as TranslationResponse;
    } catch (err) {
      logger.error({ err }, 'Translation request failed');
      throw err;
    }
  }
}
