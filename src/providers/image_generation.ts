import { logger } from '../utils/logger.js';
import axios, { AxiosInstance } from 'axios';

export interface ImageGenerationResult {
  url?: string;
  b64_json?: string;
  revised_prompt?: string;
}

export interface ImageGenerationResponse {
  data: ImageGenerationResult[];
  model: string;
  created: number;
}

export interface ImageGenerationProviderConfig {
  name: string;
  api_key?: string;
  base_url?: string;
  default_model?: string;
  extra_headers?: Record<string, string>;
}

export class ImageGenerationProvider {
  name = 'image_generation';
  private client: AxiosInstance;
  private config: ImageGenerationProviderConfig;
  defaultModel: string;

  constructor(config: ImageGenerationProviderConfig) {
    this.config = config;
    this.name = config.name || 'image_generation';
    this.defaultModel = config.default_model || 'dall-e-3';

    const baseURL = this.normalizeBaseUrl(config.base_url || 'https://api.openai.com/v1');
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
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

  async generate(
    prompt: string,
    options?: {
      model?: string;
      n?: number;
      size?: string;
      quality?: string;
      response_format?: string;
      style?: string;
    },
  ): Promise<ImageGenerationResponse> {
    const model = ImageGenerationProvider.stripPrefix(options?.model || this.defaultModel);

    const body: Record<string, unknown> = {
      model,
      prompt,
      n: options?.n ?? 1,
    };

    if (options?.size) {
      body.size = options.size;
    }
    if (options?.quality) {
      body.quality = options.quality;
    }
    if (options?.response_format) {
      body.response_format = options.response_format;
    }
    if (options?.style) {
      body.style = options.style;
    }

    try {
      const response = await this.client.post('/images/generations', body);
      return response.data as ImageGenerationResponse;
    } catch (err) {
      logger.error({ err }, 'Image generation request failed');
      throw err;
    }
  }

  async edit(
    image: string,
    prompt: string,
    options?: {
      model?: string;
      mask?: string;
      n?: number;
      size?: string;
      response_format?: string;
    },
  ): Promise<ImageGenerationResponse> {
    const model = ImageGenerationProvider.stripPrefix(options?.model || 'dall-e-2');

    try {
      const formData = new FormData();
      formData.append('model', model);
      formData.append('prompt', prompt);
      formData.append('image', new Blob([Buffer.from(image, 'base64')]), 'image.png');
      if (options?.mask) {
        formData.append('mask', new Blob([Buffer.from(options.mask, 'base64')]), 'mask.png');
      }
      if (options?.n) {
        formData.append('n', String(options.n));
      }
      if (options?.size) {
        formData.append('size', options.size);
      }
      if (options?.response_format) {
        formData.append('response_format', options.response_format);
      }

      const response = await this.client.post('/images/edits', formData, {
        headers: {
          'Content-Type': 'multipart/form-data',
        },
      });
      return response.data as ImageGenerationResponse;
    } catch (err) {
      logger.error({ err }, 'Image edit request failed');
      throw err;
    }
  }

  async createVariation(
    image: string,
    options?: {
      model?: string;
      n?: number;
      size?: string;
      response_format?: string;
    },
  ): Promise<ImageGenerationResponse> {
    const model = ImageGenerationProvider.stripPrefix(options?.model || 'dall-e-2');

    try {
      const formData = new FormData();
      formData.append('model', model);
      formData.append('image', new Blob([Buffer.from(image, 'base64')]), 'image.png');
      if (options?.n) {
        formData.append('n', String(options.n));
      }
      if (options?.size) {
        formData.append('size', options.size);
      }
      if (options?.response_format) {
        formData.append('response_format', options.response_format);
      }

      const response = await this.client.post('/images/variations', formData, {
        headers: {
          'Content-Type': 'multipart/form-data',
        },
      });
      return response.data as ImageGenerationResponse;
    } catch (err) {
      logger.error({ err }, 'Image variation request failed');
      throw err;
    }
  }
}
