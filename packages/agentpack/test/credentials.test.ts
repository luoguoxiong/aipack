/**
 * 统一凭证解析测试：resolveApiKey 优先级 / EnvCredentialStore
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  envKeyName,
  resolveApiKey,
  resolveApiKeyFromEnv,
  EnvCredentialStore,
  createEnvCredentialStore,
} from '../ai/credentials';
import type { Model } from '../ai/types';
import { AgentError } from '../ai/errors';

const deepseek: Model = {
  id: 'deepseek-chat',
  name: 'deepseek-chat',
  provider: 'deepseek',
  contextWindow: 64000,
  maxTokens: 8192,
  reasoning: false,
};

describe('envKeyName', () => {
  it('provider id 转环境变量名', () => {
    assert.equal(envKeyName('deepseek'), 'DEEPSEEK_API_KEY');
    assert.equal(envKeyName('openai'), 'OPENAI_API_KEY');
    assert.equal(envKeyName('open-router'), 'OPEN_ROUTER_API_KEY');
  });
});

describe('resolveApiKeyFromEnv', () => {
  it('按 <PROVIDER>_API_KEY 读取', () => {
    const env = { DEEPSEEK_API_KEY: 'sk-deep' };
    assert.equal(resolveApiKeyFromEnv('deepseek', env), 'sk-deep');
  });
  it('openai 回退 OPENAI_API_KEY', () => {
    assert.equal(resolveApiKeyFromEnv('openai', { OPENAI_API_KEY: 'sk-oa' }), 'sk-oa');
  });
  it('非 openai provider 不读取 OPENAI_API_KEY', () => {
    assert.equal(resolveApiKeyFromEnv('deepseek', { OPENAI_API_KEY: 'sk-oa' }), undefined);
  });
  it('无 env 返回 undefined', () => {
    assert.equal(resolveApiKeyFromEnv('deepseek', undefined), undefined);
  });
});

describe('resolveApiKey 优先级', () => {
  it('显式 apiKey 优先', async () => {
    const key = await resolveApiKey(deepseek, {
      apiKey: 'sk-explicit',
      env: { DEEPSEEK_API_KEY: 'sk-env' },
    });
    assert.equal(key, 'sk-explicit');
  });

  it('注入 credentials 优先于 env', async () => {
    const key = await resolveApiKey(deepseek, {
      env: { DEEPSEEK_API_KEY: 'sk-env' },
      credentials: {
        read: async () => 'sk-kms',
        list: async () => [],
        modify: async () => {},
        delete: async () => {},
      },
    });
    assert.equal(key, 'sk-kms');
  });

  it('credentials 返回非字符串时降级 env', async () => {
    const key = await resolveApiKey(deepseek, {
      env: { DEEPSEEK_API_KEY: 'sk-env' },
      credentials: {
        read: async () => ({ secret: 'x' }),
        list: async () => [],
        modify: async () => {},
        delete: async () => {},
      },
    });
    assert.equal(key, 'sk-env');
  });

  it('credentials 抛错时降级 env（不阻断流程）', async () => {
    const key = await resolveApiKey(deepseek, {
      env: { DEEPSEEK_API_KEY: 'sk-env' },
      credentials: {
        read: async () => {
          throw new AgentError('kms down', { category: 'retryable' });
        },
        list: async () => [],
        modify: async () => {},
        delete: async () => {},
      },
    });
    assert.equal(key, 'sk-env');
  });

  it('无任何来源返回 undefined', async () => {
    const key = await resolveApiKey(deepseek, {});
    assert.equal(key, undefined);
  });
});

describe('EnvCredentialStore', () => {
  it('read 从 env 读取', async () => {
    const store = createEnvCredentialStore({ DEEPSEEK_API_KEY: 'sk-1' });
    assert.equal(await store.read('deepseek'), 'sk-1');
  });

  it('list 返回空（env 不可枚举）', async () => {
    const store = new EnvCredentialStore({});
    assert.deepEqual(await store.list(), []);
  });

  it('modify 应用 fn 但不写回（env 只读）', async () => {
    const store = new EnvCredentialStore({ DEEPSEEK_API_KEY: 'sk-1' });
    let applied = false;
    await store.modify('deepseek', async (credential) => {
      assert.equal(credential, 'sk-1');
      applied = true;
      return credential;
    });
    assert.equal(applied, true);
    assert.equal(await store.read('deepseek'), 'sk-1', 'env 不应被修改');
  });

  it('delete no-op 不抛错', async () => {
    const store = new EnvCredentialStore({ DEEPSEEK_API_KEY: 'sk-1' });
    await store.delete('deepseek');
    assert.equal(await store.read('deepseek'), 'sk-1');
  });
});
