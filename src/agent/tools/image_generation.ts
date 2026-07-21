import { BaseTool, ToolContext, ToolResult, createToolResult, createToolError } from './base.js';
import { z } from 'zod';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import crypto from 'crypto';
import { logger } from '../../utils/logger.js';

const ImageGenerationSchema = z.object({
  prompt: z.string().min(1).describe(
    'Detailed image generation or edit prompt. Include style, subject, composition, colors, and constraints.',
  ),
  reference_images: z.array(z.string()).optional().describe(
    'Optional local image paths. Use generated artifact paths for iterative edits.',
  ),
  aspect_ratio: z.string().optional().describe(
    'Optional output aspect ratio, e.g. 1:1, 16:9, 9:16, 4:3.',
  ),
  image_size: z.string().optional().describe(
    'Optional output size hint supported by the configured provider, e.g. 1K, 2K, 4K, or 1024x1024.',
  ),
  count: z.number().int().min(1).max(8).optional().describe(
    'Number of images to generate in this turn.',
  ),
});

export interface ImageGenerationConfig {
  enabled: boolean;
  provider: string;
  model: string;
  default_aspect_ratio: string;
  default_image_size: string;
  max_images_per_turn: number;
  save_dir: string;
  api_key?: string;
  api_base?: string;
  extra_headers?: Record<string, string>;
  extra_body?: Record<string, unknown>;
}

export interface GeneratedImageArtifact {
  id: string;
  path: string;
  relative_path: string;
  url?: string;
  mime_type: string;
  size_bytes: number;
  created_at: string;
  prompt: string;
  model: string;
  provider: string;
  source_images?: string[];
}

export interface ImageGenerationResponse {
  images: string[];
  model?: string;
  provider?: string;
}

export interface ImageGenerationProvider {
  generate(params: {
    prompt: string;
    model: string;
    reference_images?: string[];
    aspect_ratio?: string;
    image_size?: string;
  }): Promise<ImageGenerationResponse>;
}

class OpenAIImageProvider implements ImageGenerationProvider {
  private apiKey?: string;
  private apiBase: string;
  private extraHeaders: Record<string, string>;
  private extraBody: Record<string, unknown>;

  constructor(opts: {
    api_key?: string;
    api_base?: string;
    extra_headers?: Record<string, string>;
    extra_body?: Record<string, unknown>;
  } = {}) {
    this.apiKey = opts.api_key || process.env.OPENAI_API_KEY;
    this.apiBase = opts.api_base || 'https://api.openai.com/v1';
    this.extraHeaders = opts.extra_headers || {};
    this.extraBody = opts.extra_body || {};
  }

  async generate(params: {
    prompt: string;
    model: string;
    reference_images?: string[];
    aspect_ratio?: string;
    image_size?: string;
  }): Promise<ImageGenerationResponse> {
    if (!this.apiKey) {
      throw new Error('OpenAI API key not configured');
    }

    const size = this._mapSize(params.image_size, params.aspect_ratio);
    const body: Record<string, unknown> = {
      model: params.model,
      prompt: params.prompt,
      n: 1,
      size,
      response_format: 'b64_json',
      ...this.extraBody,
    };

    const res = await fetch(`${this.apiBase}/images/generations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
        ...this.extraHeaders,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`OpenAI image generation failed: ${res.status} ${text}`);
    }

    const data = await res.json() as {
      data: Array<{ b64_json: string; url?: string }>;
    };

    const images: string[] = [];
    for (const item of data.data) {
      if (item.b64_json) {
        images.push(`data:image/png;base64,${item.b64_json}`);
      } else if (item.url) {
        const imgRes = await fetch(item.url);
        const buffer = Buffer.from(await imgRes.arrayBuffer());
        images.push(`data:image/png;base64,${buffer.toString('base64')}`);
      }
    }

    return { images, model: params.model, provider: 'openai' };
  }

  private _mapSize(imageSize?: string, aspectRatio?: string): string {
    if (imageSize) {
      const sizeMap: Record<string, string> = {
        '1K': '1024x1024',
        '2K': '2048x2048',
        '1024x1024': '1024x1024',
        '1792x1024': '1792x1024',
        '1024x1792': '1024x1792',
      };
      if (sizeMap[imageSize]) return sizeMap[imageSize];
    }
    const ar = aspectRatio || '1:1';
    if (ar === '16:9') return '1792x1024';
    if (ar === '9:16') return '1024x1792';
    if (ar === '4:3') return '1024x1024';
    return '1024x1024';
  }
}

function getImageGenProvider(provider: string): (new (opts?: any) => ImageGenerationProvider) | null {
  const providers: Record<string, new (opts?: any) => ImageGenerationProvider> = {
    openai: OpenAIImageProvider,
    openrouter: OpenAIImageProvider,
  };
  return providers[provider] || null;
}

function detectImageMime(data: Buffer): string | null {
  if (data.length < 8) return null;
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'image/png';
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) return 'image/gif';
  if (data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46) {
    if (data.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  }
  if (data.slice(0, 2).toString('ascii') === 'BM') return 'image/bmp';
  if (data.slice(0, 4).toString('ascii') === '<svg') return 'image/svg+xml';
  return null;
}

function extFromMime(mime: string): string {
  const map: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/bmp': '.bmp',
    'image/svg+xml': '.svg',
  };
  return map[mime] || '.png';
}

function storeGeneratedImageArtifact(
  dataUrl: string,
  opts: {
    prompt: string;
    model: string;
    source_images?: string[];
    save_dir?: string;
    provider?: string;
    workspace?: string;
  },
): GeneratedImageArtifact {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) {
    throw new Error('Invalid data URL format');
  }
  const mimeType = match[1];
  const base64 = match[2];
  const buffer = Buffer.from(base64, 'base64');

  const id = 'img_' + crypto.randomBytes(8).toString('hex');
  const ext = extFromMime(mimeType);
  const workspace = opts.workspace || process.cwd();
  const saveDir = opts.save_dir || 'generated';
  const fullSaveDir = path.join(workspace, saveDir);
  const filename = `${id}${ext}`;
  const fullPath = path.join(fullSaveDir, filename);

  fsSync.mkdirSync(fullSaveDir, { recursive: true });
  fsSync.writeFileSync(fullPath, buffer);

  const stat = fsSync.statSync(fullPath);

  return {
    id,
    path: fullPath,
    relative_path: path.join(saveDir, filename).split(path.sep).join('/'),
    mime_type: mimeType,
    size_bytes: stat.size,
    created_at: new Date().toISOString(),
    prompt: opts.prompt,
    model: opts.model,
    provider: opts.provider || 'unknown',
    source_images: opts.source_images,
  };
}

function generatedImageToolResult(artifacts: GeneratedImageArtifact[]): string {
  const payload = {
    artifacts: artifacts.map(a => ({
      id: a.id,
      path: a.relative_path,
      absolute_path: a.path,
      mime_type: a.mime_type,
      size_bytes: a.size_bytes,
      created_at: a.created_at,
      model: a.model,
      provider: a.provider,
    })),
    next_step: (
      'These images were generated and saved as local artifacts. ' +
      "Call the message tool with the artifact 'path' values in the media " +
      'parameter to deliver the images to the user. Do not paste base64 or raw ' +
      'paths into your reply unless the user asks for debug details.'
    ),
  };
  return JSON.stringify(payload, null, 2);
}

export class ImageGenerationTool extends BaseTool {
  name = 'generate_image';
  description = (
    'Generate or edit images and store them as persistent artifacts. ' +
    'Returns artifact ids and local paths. For edits, pass prior generated image paths ' +
    'or user image paths as reference_images.'
  );
  input_schema = ImageGenerationSchema;
  tags = ['image', 'generation'];

  private config: ImageGenerationConfig;
  private workspace: string;

  constructor(config?: Partial<ImageGenerationConfig>, workspace?: string) {
    super();
    this.config = {
      enabled: true,
      provider: 'openai',
      model: 'dall-e-3',
      default_aspect_ratio: '1:1',
      default_image_size: '1K',
      max_images_per_turn: 4,
      save_dir: 'generated',
      ...config,
    };
    this.workspace = workspace || process.cwd();
  }

  private _providerClient(): ImageGenerationProvider | null {
    const cls = getImageGenProvider(this.config.provider);
    if (!cls) return null;
    return new cls({
      api_key: this.config.api_key,
      api_base: this.config.api_base,
      extra_headers: this.config.extra_headers,
      extra_body: this.config.extra_body,
    });
  }

  private async _resolveReferenceImage(value: string): Promise<string> {
    const resolved = path.isAbsolute(value)
      ? value
      : path.resolve(this.workspace, value);
    try {
      const stat = await fs.stat(resolved);
      if (!stat.isFile()) {
        throw new Error(`reference image is not a file: ${value}`);
      }
      const raw = await fs.readFile(resolved);
      if (!detectImageMime(raw)) {
        throw new Error(`unsupported reference image: ${value}`);
      }
      return resolved;
    } catch (err) {
      throw new Error(`reference image not found or invalid: ${value}`);
    }
  }

  private async _resolveReferenceImages(values?: string[]): Promise<string[]> {
    if (!values || values.length === 0) return [];
    const results: string[] = [];
    for (const v of values) {
      if (v) results.push(await this._resolveReferenceImage(v));
    }
    return results;
  }

  async execute(args: unknown, context: ToolContext): Promise<ToolResult> {
    try {
      const params = this.input_schema.parse(args);
      const client = this._providerClient();
      if (!client) {
        return createToolError(
          `Error: unsupported image generation provider '${this.config.provider}'`,
        );
      }

      const requested = params.count || 1;
      if (requested > this.config.max_images_per_turn) {
        return createToolError(
          `Error: count exceeds maxImagesPerTurn (${this.config.max_images_per_turn})`,
        );
      }

      const refs = await this._resolveReferenceImages(params.reference_images);
      const artifacts: GeneratedImageArtifact[] = [];
      const ws = context.workspace || this.workspace;

      while (artifacts.length < requested) {
        const response = await client.generate({
          prompt: params.prompt,
          model: this.config.model,
          reference_images: refs,
          aspect_ratio: params.aspect_ratio || this.config.default_aspect_ratio,
          image_size: params.image_size || this.config.default_image_size,
        });
        for (const imageDataUrl of response.images) {
          const artifact = storeGeneratedImageArtifact(imageDataUrl, {
            prompt: params.prompt,
            model: this.config.model,
            source_images: refs,
            save_dir: this.config.save_dir,
            provider: this.config.provider,
            workspace: ws,
          });
          artifacts.push(artifact);
          if (artifacts.length >= requested) break;
        }
      }

      return createToolResult(generatedImageToolResult(artifacts));
    } catch (err) {
      logger.error({ error: (err as Error).message }, 'Image generation failed');
      return createToolError(`Error: ${(err as Error).message}`);
    }
  }
}

export function getImageGenerationTools(
  config?: Partial<ImageGenerationConfig>,
  workspace?: string,
): BaseTool[] {
  return [new ImageGenerationTool(config, workspace)];
}
