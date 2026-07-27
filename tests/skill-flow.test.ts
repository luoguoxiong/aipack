import { describe, it } from 'node:test';
import assert from 'node:assert';
import path from 'path';
import { fileURLToPath } from 'url';
import { SkillLoader } from '../src/skill/loader';
import { SkillRegistry } from '../src/skill/registry';
import { SkillRouter } from '../src/skill/router';
import { SkillRuntime } from '../src/skill/runtime';
import { ContextManager } from '../src/skill/context-manager';
import { PromptCompiler } from '../src/skill/prompt-compiler';
import { SkillManager } from '../src/skill/manager';
import { createDefaultToolRegistry } from '../src/tools/registry';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SKILLS_DIR = path.resolve(__dirname, '../skills');

describe('Skill System - 端到端流程验证', () => {
  // ─── 1. Loader ───
  describe('Loader', () => {
    it('应该扫描到 code-review skill', () => {
      const loader = new SkillLoader();
      const skills = loader.scanDirectory(SKILLS_DIR);
      assert.ok(skills.length >= 1, `未扫描到 skill, dir=${SKILLS_DIR}`);

      const cr = skills.find(s => s.manifest.name === 'code-review');
      assert.ok(cr, '应该找到 code-review skill');
      assert.strictEqual(cr.manifest.version, '1.0.0');
      assert.strictEqual(cr.manifest.type, 'workflow');
      assert.strictEqual(cr.manifest.description, '自动代码审查，检查安全性、性能、可维护性和最佳实践');
    });

    it('YAML 解析应该正确识别 trigger.keywords', () => {
      const loader = new SkillLoader();
      const skills = loader.scanDirectory(SKILLS_DIR);
      const cr = skills.find(s => s.manifest.name === 'code-review')!;

      assert.ok(cr.manifest.trigger, '缺少 trigger');
      assert.ok(cr.manifest.trigger!.keywords, '缺少 keywords');
      assert.ok(cr.manifest.trigger!.keywords!.includes('review'), '应包含 "review"');
      assert.ok(cr.manifest.trigger!.keywords!.includes('代码审查'), '应包含 "代码审查"');
      assert.strictEqual(cr.manifest.trigger!.priority, 10);
    });

    it('YAML 解析应该正确识别 context.include → required', () => {
      const loader = new SkillLoader();
      const skills = loader.scanDirectory(SKILLS_DIR);
      const cr = skills.find(s => s.manifest.name === 'code-review')!;

      assert.ok(cr.manifest.context, '缺少 context');
      assert.ok(cr.manifest.context!.required, 'context.required 应该由 context.include 映射而来');
      assert.ok(cr.manifest.context!.required!.includes('git.diff'));
    });

    it('YAML 解析应该正确识别 runtime', () => {
      const loader = new SkillLoader();
      const skills = loader.scanDirectory(SKILLS_DIR);
      const cr = skills.find(s => s.manifest.name === 'code-review')!;

      assert.strictEqual(cr.manifest.runtime!.timeout, 60000);
      assert.strictEqual(cr.manifest.runtime!.retry, 1);
    });

    it('应该加载 SKILL.md', () => {
      const loader = new SkillLoader();
      const skills = loader.scanDirectory(SKILLS_DIR);
      const cr = skills.find(s => s.manifest.name === 'code-review')!;

      assert.ok(cr.promptMd.length > 0, 'SKILL.md 不应为空');
      assert.ok(cr.promptMd.includes('# Code Review Skill'), '应包含标题');
      assert.ok(cr.promptMd.includes('Output Format'), '应包含 Output Format');
    });

    it('应该识别 handler.ts', () => {
      const loader = new SkillLoader();
      const skills = loader.scanDirectory(SKILLS_DIR);
      const cr = skills.find(s => s.manifest.name === 'code-review')!;

      assert.ok(cr.handlerPath, 'handler 路径不应为空');
      assert.ok(cr.handlerPath!.endsWith('handler.ts'));
    });

    it('空目录应返回空数组', () => {
      const loader = new SkillLoader();
      const emptyDir = path.resolve(__dirname, '_nonexistent_');
      const skills = loader.scanDirectory(emptyDir);
      assert.strictEqual(skills.length, 0);
    });
  });

  // ─── 2. Registry ───
  describe('Registry', () => {
    it('应该注册和获取 Skill', () => {
      const registry = new SkillRegistry();
      const loader = new SkillLoader();
      const skills = loader.scanDirectory(SKILLS_DIR);
      assert.ok(skills.length > 0, '需要至少一个 skill');

      registry.register(skills[0]);
      assert.ok(registry.has(skills[0].manifest.name));
      assert.strictEqual(registry.count(), 1);
      assert.strictEqual(registry.get(skills[0].manifest.name), skills[0]);
    });

    it('禁用列表应阻止注册', () => {
      const registry = new SkillRegistry();
      const loader = new SkillLoader();
      const skills = loader.scanDirectory(SKILLS_DIR);
      registry.applyDisabledList([skills[0].manifest.name]);

      registry.register(skills[0]);
      assert.strictEqual(registry.count(), 0);
      assert.strictEqual(registry.isDisabled(skills[0].manifest.name), true);
    });

    it('findBestMatch 应按 Level > priority > confidence 排序', () => {
      const registry = new SkillRegistry();
      const matches = [
        { skillName: 'a', confidence: 0.5, level: 1 as const, triggerType: 'keyword' as const, priority: 0 },
        { skillName: 'b', confidence: 0.8, level: 0 as const, triggerType: 'explicit' as const, priority: 0 },
        { skillName: 'c', confidence: 0.3, level: 1 as const, triggerType: 'keyword' as const, priority: 10 },
      ];

      const best = registry.findBestMatch(matches);
      assert.strictEqual(best!.skillName, 'b', 'Level 0 应优先');
    });

    it('无匹配时 findBestMatch 返回 null', () => {
      const registry = new SkillRegistry();
      assert.strictEqual(registry.findBestMatch([]), null);
    });
  });

  // ─── 3. Router ───
  describe('Router', () => {
    const mockSkill = (name: string, keywords?: string[], priority = 0) => ({
      manifest: {
        name,
        version: '1.0.0',
        type: 'action' as const,
        description: '',
        trigger: keywords ? { keywords, priority } : undefined,
      },
      promptMd: '',
      sourceDir: '/tmp/' + name,
      registeredAt: Date.now(),
    });

    it('Level 0: 显式调用 /skillName', () => {
      const registry = new SkillRegistry();
      const router = new SkillRouter(registry);
      registry.register(mockSkill('review', ['review']));
      const result = router.route('/review this code');
      assert.ok(result.match);
      assert.strictEqual(result.match!.level, 0);
      assert.strictEqual(result.match!.triggerType, 'explicit');
      assert.strictEqual(result.match!.confidence, 1.0);
    });

    it('Level 0: 不应匹配非显式调用', () => {
      const registry = new SkillRegistry();
      const router = new SkillRouter(registry);
      registry.register(mockSkill('review', ['review']));
      const result = router.route('please review this code');
      assert.ok(result.match);
      assert.strictEqual(result.match!.level, 1); // keyword match
    });

    it('Level 1: 关键词匹配', () => {
      const registry = new SkillRegistry();
      const router = new SkillRouter(registry);
      registry.register(mockSkill('code-review', ['review', '代码审查']));
      const result = router.route('请帮我做代码审查');
      assert.ok(result.match);
      assert.strictEqual(result.match!.level, 1);
      assert.strictEqual(result.match!.triggerType, 'keyword');
    });

    it('Level 1: 多个关键词提高 confidence', () => {
      const registry = new SkillRegistry();
      const router = new SkillRouter(registry);
      registry.register(mockSkill('code-review', ['review', '代码审查', 'CR']));
      const result1 = router.route('review');
      const result2 = router.route('CR 代码审查 review');

      assert.ok(result1.match);
      assert.ok(Math.abs(result1.match!.confidence - 0.45) < 0.001, `expected ~0.45, got ${result1.match!.confidence}`); // 0.3 + 1*0.15

      assert.ok(result2.match);
      assert.ok(Math.abs(result2.match!.confidence - 0.75) < 0.001, `expected ~0.75, got ${result2.match!.confidence}`); // 0.3 + 3*0.15
    });

    it('Level 2: 文件模式匹配', () => {
      const registry = new SkillRegistry();
      const router = new SkillRouter(registry);
      registry.register({
        manifest: {
          name: 'vue-review',
          version: '1.0.0',
          type: 'action',
          description: '',
          trigger: { file_patterns: ['*.vue'] },
        },
        promptMd: '',
        sourceDir: '/tmp/vue-review',
        registeredAt: Date.now(),
      });
      const result = router.route('帮我检查这个文件', { currentFile: 'App.vue' });
      assert.ok(result.match);
      assert.strictEqual(result.match!.level, 2);
      assert.strictEqual(result.match!.triggerType, 'file');
    });

    it('无匹配应返回 null', () => {
      const registry = new SkillRegistry();
      const router = new SkillRouter(registry);
      registry.register(mockSkill('review', ['review']));
      const result = router.route('hello world');
      assert.strictEqual(result.match, null);
      assert.strictEqual(result.matchedSkill, null);
    });

    it('多级匹配: Level 0 应优先于 Level 1', () => {
      const registry = new SkillRegistry();
      const router = new SkillRouter(registry);
      registry.register(mockSkill('review', ['review'], 5));
      registry.register({
        ...mockSkill('code-review', ['review'], 10),
        manifest: { ...mockSkill('code-review', ['review'], 10).manifest, name: 'code-review' },
      });
      const cr = {
        manifest: {
          name: 'cr',
          version: '1.0.0',
          type: 'action' as const,
          description: '',
          trigger: { keywords: ['review'], priority: 100 },
        },
        promptMd: '',
        sourceDir: '/tmp/cr',
        registeredAt: Date.now(),
      };
      registry.register(cr);
      const review = {
        manifest: {
          name: 'review',
          version: '1.0.0',
          type: 'action' as const,
          description: '',
        },
        promptMd: '',
        sourceDir: '/tmp/review',
        registeredAt: Date.now(),
      };
      registry.register(review);

      const result = router.route('/review this');
      assert.ok(result.match);
      assert.strictEqual(result.match!.skillName, 'review', '显式匹配 /review 应优先');
    });
  });

  // ─── 4. ContextManager ───
  describe('ContextManager', () => {
    it('required 文件不存在时返回占位符', async () => {
      const cm = new ContextManager('/tmp');
      const skill = {
        manifest: {
          name: 'test',
          version: '1.0.0',
          type: 'action' as const,
          description: '',
          context: { required: ['git.diff', 'nonexistent.sh'] },
        },
        promptMd: '',
        sourceDir: '/tmp/test',
        registeredAt: Date.now(),
      };

      const ctx = await cm.prepare(skill);
      assert.ok(Array.isArray(ctx.files));
      assert.strictEqual(ctx.files.length, 2);
      // git.diff 是特殊路径，返回空
      // nonexistent.sh 不存在
    });

    it('max_tokens 截断', async () => {
      const cm = new ContextManager('/tmp');
      const skill = {
        manifest: {
          name: 'test',
          version: '1.0.0',
          type: 'action' as const,
          description: '',
          context: { required: ['git.diff'], max_tokens: 1 },
        },
        promptMd: '',
        sourceDir: '/tmp/test',
        registeredAt: Date.now(),
      };

      const ctx = await cm.prepare(skill);
      assert.ok(ctx.tokens <= 100); // 即使 max_tokens 很小也能正确处理
    });
  });

  // ─── 5. PromptCompiler ───
  describe('PromptCompiler', () => {
    it('应移除 YAML Frontmatter', () => {
      const pc = new PromptCompiler();
      const skill = {
        manifest: { name: 't', version: '1.0.0', type: 'action' as const, description: '' },
        promptMd: '---\nname: test\n---\n# Real content\nhello',
        sourceDir: '/tmp/t',
        registeredAt: Date.now(),
      };

      const result = pc.compile(skill, {
        context: { files: [], memory: [], summary: '', tokens: 0, size: 0, cost: 0, truncated: false },
      });
      assert.ok(result.system.includes('# Real content'), 'Frontmatter 被移除后应保留真正内容');
      assert.ok(!result.system.includes('name: test'), 'Frontmatter 不应出现在输出中');
    });

    it('应注入 Context 和 Tool 信息', () => {
      const pc = new PromptCompiler();
      const skill = {
        manifest: { name: 't', version: '1.0.0', type: 'action' as const, description: '' },
        promptMd: '# Instructions\nDo X',
        sourceDir: '/tmp/t',
        registeredAt: Date.now(),
      };

      const result = pc.compile(skill, {
        context: {
          files: ['`config.json`:\n{"key": "value"}'],
          memory: [],
          summary: 'Summary text',
          tokens: 100,
          size: 100,
          cost: 100,
          truncated: false,
        },
        toolDescriptions: ['shell', 'write_file'],
        userInput: '帮我做X',
      });

      assert.ok(result.system.includes('# Instructions'), '应包含 Instructions');
      assert.ok(result.system.includes('Context Files'), '应包含 Context');
      assert.ok(result.system.includes('Available Tools'), '应包含 Tools');
      assert.ok(result.system.includes('shell'), '应包含 shell tool');
      assert.ok(result.system.includes('User Request'), '应包含 User Request');
    });
  });

  // ─── 6. Runtime ───
  describe('Runtime', () => {
    it('compilePrompt 不执行 handler，只编译 prompt', async () => {
      const registry = createDefaultToolRegistry();
      const runtime = new SkillRuntime(registry, '/tmp');
      const skill = {
        manifest: {
          name: 'test',
          version: '1.0.0',
          type: 'action' as const,
          description: 'Test skill',
        },
        promptMd: '# Test Instructions',
        sourceDir: '/tmp/test',
        registeredAt: Date.now(),
      };

      const { compiled, context } = await runtime.compilePrompt(skill, {
        userInput: 'do something',
      });

      assert.ok(typeof compiled === 'string');
      assert.ok(compiled.includes('# Test Instructions'));
      assert.ok(compiled.includes('do something'));
      // 不调用 handler — compilePrompt 只编译不执行
    });

    it('无 handler 的 knowledge skill 应返回 prompt', async () => {
      const registry = createDefaultToolRegistry();
      const runtime = new SkillRuntime(registry, '/tmp');
      const skill = {
        manifest: {
          name: 'doc-lookup',
          version: '1.0.0',
          type: 'knowledge' as const,
          description: 'Documentation lookup',
        },
        promptMd: '# Documentation\nHere is the knowledge base.',
        sourceDir: '/tmp/doc-lookup',
        registeredAt: Date.now(),
      };

      const result = await runtime.execute(skill, { userInput: 'how to X?' });
      assert.strictEqual(result.status, 'success');
      assert.ok(result.content.includes('# Documentation'));
    });
  });

  // ─── 7. Manager 端到端 ───
  describe('SkillManager 端到端', () => {
    it('初始化 + 匹配 + 编译 prompt', async () => {
      const toolRegistry = createDefaultToolRegistry();
      const manager = new SkillManager(toolRegistry, {
        skillsDir: SKILLS_DIR,
        workspace: '/tmp',
      });

      const count = manager.initialize();
      assert.ok(count >= 1, `应有至少 1 个 skill, 实际: ${count}`);

      // 测试 Level 1 关键词匹配: "review"
      const match = manager.match('帮我 review 这个 PR');
      assert.ok(match.match, 'review 应匹配');
      assert.strictEqual(match.match!.skillName, 'code-review');
      assert.ok(match.matchedSkill);

      // 测试编译 prompt
      const { compiled } = await manager.compileSkillPrompt(match.matchedSkill!, {
        userInput: '帮我 review 这个 PR',
      });
      assert.ok(compiled.includes('# Code Review Skill'), 'prompt 应包含 SKILL.md 内容');
      assert.ok(compiled.length > 100, 'compiled prompt 不应太短');
    });

    it('无匹配时不触发执行', async () => {
      const toolRegistry = createDefaultToolRegistry();
      const manager = new SkillManager(toolRegistry, {
        skillsDir: SKILLS_DIR,
      });

      manager.initialize();
      const { match, result } = await manager.matchAndExecute('你好');
      assert.strictEqual(match.match, null);
      assert.strictEqual(result, undefined);
    });

    it('reload 应重新加载', () => {
      const toolRegistry = createDefaultToolRegistry();
      const manager = new SkillManager(toolRegistry, {
        skillsDir: SKILLS_DIR,
      });

      const count1 = manager.initialize();
      const count2 = manager.reload();

      assert.strictEqual(count1, count2);
      assert.ok(manager.registry.count() >= 1);
    });

    it('重名时第二次注册覆盖第一次', () => {
      const registry = new SkillRegistry();
      registry.register({
        manifest: { name: 'dup', version: '1.0.0', type: 'action', description: 'v1' },
        promptMd: '', sourceDir: '/tmp/dup', registeredAt: Date.now(),
      });
      registry.register({
        manifest: { name: 'dup', version: '2.0.0', type: 'action', description: 'v2' },
        promptMd: '', sourceDir: '/tmp/dup', registeredAt: Date.now(),
      });

      assert.strictEqual(registry.count(), 1);
      assert.strictEqual(registry.get('dup')!.manifest.version, '2.0.0');
    });
  });
});
