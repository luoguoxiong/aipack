import type {
  ImagesModel,
  ImagesProvider,
  ImageInputBlock,
  ImageOutputBlock,
  AssistantImages,
  ImagesGenerateOptions,
} from './types';
import { BUILTIN_IMAGES_MODELS } from './catalog';

// ─── OpenAI 图片生成 (DALL-E) ─────────────────────────────

async function generateOpenAIImages(
  model: ImagesModel,
  input: ImageInputBlock[],
  options: ImagesGenerateOptions = {},
): Promise<AssistantImages> {
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return {
      output: [],
      stopReason: 'error',
      usage: undefined,
    };
  }

  const prompt = input.find((b) => b.type === 'text')?.text ?? '';
  const baseUrl = 'https://api.openai.com/v1';

  const body: Record<string, unknown> = {
    model: model.id,
    prompt,
    n: 1,
    size: options.size ?? '1024x1024',
    quality: options.quality ?? 'standard',
    response_format: 'b64_json',
  };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
    ...(options.headers ?? {}),
  };

  try {
    const response = await fetch(`${baseUrl}/images/generations`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: options.signal,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      return {
        output: [{ type: 'text', text: `Image generation failed: ${response.status} ${errText}` }],
        stopReason: 'error',
      };
    }

    const data = await response.json() as any;
    const output: ImageOutputBlock[] = [];

    if (data.data && Array.isArray(data.data)) {
      for (const item of data.data) {
        if (item.b64_json) {
          output.push({ type: 'image', data: item.b64_json, mimeType: 'image/png' });
        } else if (item.url) {
          // 从 URL 获取图片并转换为 base64
          try {
            const imgResponse = await fetch(item.url);
            const buffer = await imgResponse.arrayBuffer();
            const base64 = Buffer.from(buffer).toString('base64');
            output.push({ type: 'image', data: base64, mimeType: 'image/png' });
          } catch {
            output.push({ type: 'text', text: `[Image URL: ${item.url}]` });
          }
        }
        if (item.revised_prompt) {
          output.push({ type: 'text', text: item.revised_prompt });
        }
      }
    }

    return {
      output,
      stopReason: 'stop',
      responseId: data.id,
    };
  } catch (e: any) {
    const aborted = e?.name === 'AbortError' || options.signal?.aborted;
    return {
      output: [{ type: 'text', text: aborted ? 'Image generation aborted' : String(e?.message ?? e) }],
      stopReason: aborted ? 'aborted' : 'error',
    };
  }
}

// ─── OpenRouter 图片生成 ──────────────────────────────────

async function generateOpenRouterImages(
  model: ImagesModel,
  input: ImageInputBlock[],
  options: ImagesGenerateOptions = {},
): Promise<AssistantImages> {
  const apiKey = options.apiKey ?? process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return { output: [], stopReason: 'error' };
  }

  const baseUrl = 'https://openrouter.ai/api/v1';
  const messages = input.map((b) => {
    if (b.type === 'text') return { role: 'user', content: b.text };
    return {
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: `data:${b.mimeType};base64,${b.data}` } }],
    };
  });

  const body = {
    model: model.id,
    messages,
    modalities: ['image', 'text'],
  };

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        ...(options.headers ?? {}),
      },
      body: JSON.stringify(body),
      signal: options.signal,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      return {
        output: [{ type: 'text', text: `OpenRouter image generation failed: ${response.status} ${errText}` }],
        stopReason: 'error',
      };
    }

    const data = await response.json() as any;
    const output: ImageOutputBlock[] = [];
    const choice = data.choices?.[0];
    if (choice?.message?.content) {
      if (typeof choice.message.content === 'string') {
        output.push({ type: 'text', text: choice.message.content });
      } else if (Array.isArray(choice.message.content)) {
        for (const part of choice.message.content) {
          if (part.type === 'text') {
            output.push({ type: 'text', text: part.text });
          } else if (part.type === 'image_url') {
            const url = part.image_url?.url ?? '';
            if (url.startsWith('data:')) {
              const match = url.match(/^data:(.+?);base64,(.*)$/);
              if (match) {
                output.push({ type: 'image', data: match[2], mimeType: match[1] });
              }
            } else {
              try {
                const imgResponse = await fetch(url);
                const buffer = await imgResponse.arrayBuffer();
                const base64 = Buffer.from(buffer).toString('base64');
                const ct = imgResponse.headers.get('content-type') ?? 'image/png';
                output.push({ type: 'image', data: base64, mimeType: ct });
              } catch {
                output.push({ type: 'text', text: `[Image URL: ${url}]` });
              }
            }
          }
        }
      }
    }

    return { output, stopReason: 'stop', responseId: data.id };
  } catch (e: any) {
    const aborted = e?.name === 'AbortError' || options.signal?.aborted;
    return {
      output: [{ type: 'text', text: aborted ? 'Image generation aborted' : String(e?.message ?? e) }],
      stopReason: aborted ? 'aborted' : 'error',
    };
  }
}

// ─── ImagesModels 集合 ──────────────────────────────────────

export class ImagesModels {
  private providers = new Map<string, ImagesProvider>();

  setProvider(provider: ImagesProvider): void {
    this.providers.set(provider.id, provider);
  }

  getProvider(id: string): ImagesProvider | undefined {
    return this.providers.get(id);
  }

  getModels(providerId?: string): ImagesModel[] {
    if (providerId) {
      return this.getProvider(providerId)?.models ?? [];
    }
    return Array.from(this.providers.values()).flatMap((p) => p.models);
  }

  getModel(providerIdOrModel: string, modelId?: string): ImagesModel | undefined {
    if (modelId) {
      return this.getProvider(providerIdOrModel)?.models.find((m) => m.id === modelId);
    }
    for (const provider of this.providers.values()) {
      const model = provider.models.find((m) => m.id === providerIdOrModel);
      if (model) return model;
    }
    return undefined;
  }

  async generateImages(
    model: ImagesModel,
    input: ImageInputBlock[],
    options: ImagesGenerateOptions = {},
  ): Promise<AssistantImages> {
    const provider = this.getProvider(model.provider);
    if (provider?.generateImages) {
      return provider.generateImages(model, input, options);
    }

    // 根据 api 类型回退
    if (model.api === 'openai-images') {
      return generateOpenAIImages(model, input, options);
    }
    if (model.api === 'openrouter-images') {
      return generateOpenRouterImages(model, input, options);
    }

    return {
      output: [{ type: 'text', text: `No image generation implementation for API: ${model.api}` }],
      stopReason: 'error',
    };
  }
}

// ─── 工厂函数 ──────────────────────────────────────────────────────

export function createImagesModels(): ImagesModels {
  const models = new ImagesModels();

  // OpenAI 图片提供者
  models.setProvider({
    id: 'openai',
    name: 'OpenAI',
    models: BUILTIN_IMAGES_MODELS.filter((m) => m.provider === 'openai'),
    generateImages: generateOpenAIImages,
  });

  // OpenRouter 图片提供者
  models.setProvider({
    id: 'openrouter',
    name: 'OpenRouter',
    models: BUILTIN_IMAGES_MODELS.filter((m) => m.provider === 'openrouter'),
    generateImages: generateOpenRouterImages,
  });

  return models;
}
