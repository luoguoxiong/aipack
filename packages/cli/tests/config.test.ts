/**
 * CLI 配置加载与优先级测试。
 *
 * 覆盖：默认值、全局配置、项目级 .json/.js、优先级（全局 < 项目级 .json < 项目级 .js）、
 * 环境变量与 CLI 参数覆盖。回归验证"项目级配置不被全局配置覆盖"的修复。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { loadConfig } from '../src/config';

describe('loadConfig', () => {
  const originalCwd = process.cwd();
  const originalConfigDir = process.env.AIPACK_CONFIG_DIR;
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cli-config-test-'));
  });

  after(async () => {
    process.chdir(originalCwd);
    if (originalConfigDir === undefined) {
      delete process.env.AIPACK_CONFIG_DIR;
    } else {
      process.env.AIPACK_CONFIG_DIR = originalConfigDir;
    }
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  /** 在隔离目录中准备测试环境并加载配置 */
  async function loadIn(dir: string, cli: Parameters<typeof loadConfig>[0] = {}) {
    const absDir = path.join(tmpDir, dir);
    await fs.promises.mkdir(absDir, { recursive: true });
    // 全局配置目录也隔离在临时目录下
    const globalDir = path.join(absDir, '.aipack-global');
    await fs.promises.mkdir(globalDir, { recursive: true });
    process.env.AIPACK_CONFIG_DIR = globalDir;
    process.chdir(absDir);
    return loadConfig(cli);
  }

  it('无任何配置时使用默认值', async () => {
    const cfg = await loadIn('defaults');
    assert.equal(cfg.provider, 'openai');
    assert.equal(cfg.model, 'gpt-4o-mini');
    assert.equal(cfg.configPath, undefined);
  });

  it('全局配置 config.json 生效', async () => {
    const cfg = await loadIn('global-only');
    const globalFile = path.join(cfg.workspace, '.aipack-global', 'config.json');
    await fs.promises.writeFile(
      globalFile,
      JSON.stringify({ provider: 'deepseek', model: 'deepseek-chat' }),
    );
    const loaded = await loadConfig({});
    assert.equal(loaded.provider, 'deepseek');
    assert.equal(loaded.model, 'deepseek-chat');
    assert.ok(loaded.configPath?.endsWith('config.json'));
  });

  it('项目级 .json 覆盖全局配置（项目优先）', async () => {
    const dir = 'project-json-wins';
    const cfg = await loadIn(dir);
    const globalFile = path.join(cfg.workspace, '.aipack-global', 'config.json');
    await fs.promises.writeFile(
      globalFile,
      JSON.stringify({ provider: 'anthropic', model: 'claude-3' }),
    );
    await fs.promises.writeFile(
      path.join(process.cwd(), 'aipack.config.json'),
      JSON.stringify({ provider: 'deepseek', model: 'deepseek-chat' }),
    );
    const loaded = await loadConfig({});
    assert.equal(loaded.provider, 'deepseek', '项目级配置应覆盖全局配置');
    assert.equal(loaded.model, 'deepseek-chat');
  });

  it('项目级 .js 优先于 .json', async () => {
    const dir = 'project-js-wins';
    const cfg = await loadIn(dir);
    await fs.promises.writeFile(
      path.join(process.cwd(), 'aipack.config.json'),
      JSON.stringify({ provider: 'openai', model: 'gpt-4o-mini' }),
    );
    await fs.promises.writeFile(
      path.join(process.cwd(), 'aipack.config.js'),
      "export default { provider: 'deepseek', model: 'deepseek-reasoner' };\n",
    );
    const loaded = await loadConfig({});
    assert.equal(loaded.provider, 'deepseek', '项目级 .js 应优先于 .json');
    assert.equal(loaded.model, 'deepseek-reasoner');
  });

  it('环境变量覆盖配置文件', async () => {
    const dir = 'env-wins';
    const cfg = await loadIn(dir);
    await fs.promises.writeFile(
      path.join(process.cwd(), 'aipack.config.json'),
      JSON.stringify({ provider: 'openai', model: 'gpt-4o-mini' }),
    );
    process.env.AIPACK_PROVIDER = 'anthropic';
    process.env.AIPACK_MODEL = 'claude-sonnet';
    const loaded = await loadConfig({});
    assert.equal(loaded.provider, 'anthropic');
    assert.equal(loaded.model, 'claude-sonnet');
    delete process.env.AIPACK_PROVIDER;
    delete process.env.AIPACK_MODEL;
  });

  it('CLI 参数覆盖环境变量', async () => {
    const dir = 'cli-wins';
    await loadIn(dir);
    process.env.AIPACK_PROVIDER = 'anthropic';
    const loaded = await loadConfig({ provider: 'deepseek' });
    assert.equal(loaded.provider, 'deepseek');
    delete process.env.AIPACK_PROVIDER;
  });

  it('显式 --config 单独生效（忽略项目/全局）', async () => {
    const dir = 'explicit-config';
    const cfg = await loadIn(dir);
    await fs.promises.writeFile(
      path.join(process.cwd(), 'aipack.config.json'),
      JSON.stringify({ provider: 'openai', model: 'gpt-4o-mini' }),
    );
    const customFile = path.join(process.cwd(), 'my-custom.json');
    await fs.promises.writeFile(
      customFile,
      JSON.stringify({ provider: 'custom', model: 'custom-model' }),
    );
    const loaded = await loadConfig({ config: customFile });
    assert.equal(loaded.provider, 'custom');
    assert.equal(loaded.model, 'custom-model');
  });

  it('workspace 支持 ~ 展开，默认当前目录', async () => {
    const cfg = await loadIn('workspace-default');
    assert.equal(cfg.workspace, process.cwd());
  });
});
