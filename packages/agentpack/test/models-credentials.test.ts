/**
 * Phase 3-4 凭证统一测试：
 * - Models.dispatchStream 注入 this.credentials（createModels({ credentials }) 真实生效）
 * - getAuth 接线：CredentialStore → env → 自定义 auth 解析器
 * - google envVar 回归：catalog 约定名与 resolveApiKeyFromEnv 一致（GOOGLE_API_KEY）
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createModels, Models } from '../ai/models';
import { getEnvApiKey } from '../ai/catalog';
import { resolveApiKeyFromEnv } from '../ai/credentials';
import type { Model, Context, StreamEvent, CredentialStore } from '../ai/types';

const model: Model = {
  id: 'deepseek-chat',
  name: 'deepseek-chat',
  provider: 'deepseek',
  baseUrl: 'https://mock.example.com/v1',
  contextWindow: 64000,
  maxTokens: 8192,
  reasoning: false,
};

const context: Context = {
  systemPrompt: 'sys',
  messages: [{ role: 'user', content: 'hi' }],
};

// ─── mock fetch 工具（复用 stream-fetch.test 的模式）───────────────

const realFetch = globalThis.fetch;

function sseResponse(events: string[], status = 200): Response {
  const bodyStr = events.map((e) => `data: ${e}`).join('\n\n') + '\n\n';
  return new Response(new TextEncoder().encode(bodyStr), {
    status,
    headers: { 'content-type': 'text/event-stream' },
  });
}

const OK_EVENTS = [
  '{"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"hi"},"finish_reason":"stop"}]}',
  '{"id":"c1","usage":{"prompt_tokens":10,"completion_tokens":2}}',
  '[DONE]',
];

async function collect(events: AsyncIterable<StreamEvent>): Promise<void> {
  for await (const _ of events) {
    // 消费完流即可
  }
}

afterEach(() => {
  globalThis.fetch = realFetch;
  delete (process.env as Record<string, string | undefined>).DEEPSEEK_API_KEY;
  delete (process.env as Record<string, string | undefined>).GOOGLE_API_KEY;
  delete (process.env as Record<string, string | undefined>).GEMINI_API_KEY;
});

// ─── Models.credentials 注入（dispatchStream）─────────────────────

describe('Models.credentials 注入', () => {
  it('createModels({ credentials }) 注入的 key 实际用于请求', async () => {
    const reads: string[] = [];
    const store: CredentialStore = {
      read: async (providerId) => {
        reads.push(providerId);
        return 'sk-kms';
      },
      list: async () => [],
      modify: async () => {},
      delete: async () => {},
    };

    let capturedAuth: string | undefined;
    globalThis.fetch = (async (_url: unknown, init: unknown) => {
      capturedAuth = (init as { headers: Record<string, string> }).headers.Authorization;
      return sseResponse(OK_EVENTS);
    }) as typeof fetch;

    const models = createModels({ credentials: store });
    await collect(models.stream(model, context));

    assert.deepEqual(reads, ['deepseek'], '应通过注入的 store 读取 key');
    assert.equal(capturedAuth, 'Bearer sk-kms', '请求头应使用注入的 key');
  });

  it('显式 options.credentials 覆盖 Models 注入', async () => {
    const modelsStore: CredentialStore = {
      read: async () => 'sk-models',
      list: async () => [],
      modify: async () => {},
      delete: async () => {},
    };
    const explicitStore: CredentialStore = {
      read: async () => 'sk-explicit',
      list: async () => [],
      modify: async () => {},
      delete: async () => {},
    };

    let capturedAuth: string | undefined;
    globalThis.fetch = (async (_url: unknown, init: unknown) => {
      capturedAuth = (init as { headers: Record<string, string> }).headers.Authorization;
      return sseResponse(OK_EVENTS);
    }) as typeof fetch;

    const models = createModels({ credentials: modelsStore });
    await collect(models.stream(model, context, { credentials: explicitStore }));

    assert.equal(capturedAuth, 'Bearer sk-explicit', '显式 options.credentials 应优先');
  });

  it('未注入时默认 EnvCredentialStore 读取约定名环境变量', async () => {
    process.env.DEEPSEEK_API_KEY = 'sk-env';
    let capturedAuth: string | undefined;
    globalThis.fetch = (async (_url: unknown, init: unknown) => {
      capturedAuth = (init as { headers: Record<string, string> }).headers.Authorization;
      return sseResponse(OK_EVENTS);
    }) as typeof fetch;

    const models = createModels();
    await collect(models.stream(model, context));

    assert.equal(capturedAuth, 'Bearer sk-env');
  });
});

// ─── getAuth 接线 ─────────────────────────────────────────────────

describe('Models.getAuth 接线', () => {
  it('注入的 CredentialStore 优先', async () => {
    const models = new Models({
      credentials: {
        read: async () => 'sk-kms',
        list: async () => [],
        modify: async () => {},
        delete: async () => {},
      },
    });
    const auth = await models.getAuth('deepseek');
    assert.deepEqual(auth, { apiKey: 'sk-kms', source: 'credential-store' });
  });

  it('无注入时默认 EnvCredentialStore 从环境变量取 key', async () => {
    process.env.DEEPSEEK_API_KEY = 'sk-env';
    const models = createModels();
    const auth = await models.getAuth('deepseek');
    assert.equal(auth?.apiKey, 'sk-env');
    // 默认存储本身就是 env 存储，source 标记为 credential-store
    assert.equal(auth?.source, 'credential-store');
  });

  it('store 返回非字符串时回退环境变量', async () => {
    process.env.DEEPSEEK_API_KEY = 'sk-env';
    const models = new Models({
      credentials: {
        read: async () => ({ secret: 'x' }),
        list: async () => [],
        modify: async () => {},
        delete: async () => {},
      },
    });
    const auth = await models.getAuth('deepseek');
    assert.equal(auth?.apiKey, 'sk-env');
  });

  it('store 抛错时不阻断，回退环境变量', async () => {
    process.env.DEEPSEEK_API_KEY = 'sk-env';
    const models = new Models({
      credentials: {
        read: async () => {
          throw new Error('kms down');
        },
        list: async () => [],
        modify: async () => {},
        delete: async () => {},
      },
    });
    const auth = await models.getAuth('deepseek');
    assert.equal(auth?.apiKey, 'sk-env');
    // store 抛错后走步骤 2：直接 env 兜底，source 为约定变量名
    assert.equal(auth?.source, 'DEEPSEEK_API_KEY');
  });

  it('无任何来源返回 undefined', async () => {
    const models = createModels();
    const auth = await models.getAuth('deepseek');
    assert.equal(auth, undefined);
  });
});

// ─── google envVar 一致性回归 ─────────────────────────────────────

describe('google envVar 一致性（约定名）', () => {
  it('resolveApiKeyFromEnv 与 getEnvApiKey 均读取 GOOGLE_API_KEY', () => {
    process.env.GOOGLE_API_KEY = 'sk-g';
    assert.equal(getEnvApiKey('google'), 'sk-g');
    assert.equal(resolveApiKeyFromEnv('google', process.env), 'sk-g');
  });

  it('旧名 GEMINI_API_KEY 不再生效', () => {
    process.env.GEMINI_API_KEY = 'sk-old';
    assert.equal(getEnvApiKey('google'), undefined);
    assert.equal(resolveApiKeyFromEnv('google', process.env), undefined);
  });
});
