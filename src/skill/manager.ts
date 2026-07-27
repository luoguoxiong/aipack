import path from 'path';
import { logger } from '../utils/logger';
import { SkillRegistry } from './registry';
import { SkillLoader } from './loader';
import { SkillRouter } from './router';
import { SkillRuntime } from './runtime';
import type { SkillDefinition, SkillResult, RouteResult, SkillHook } from './types';
import { ToolRegistry } from '../tools/registry';

export interface SkillManagerConfig {
  skillsDir?: string;
  workspace?: string;
  disabledSkills?: string[];
}

/**
 * Skill Manager — 统一入口，管理 Skill 的全生命周期
 *
 * 职责：
 * 1. 启动时加载所有 Skill
 * 2. 提供路由匹配
 * 3. 管理 Runtime 执行
 * 4. 提供 Hook 注册能力
 * 5. 将 Skill 结果转换为 Agent 可用的上下文
 */
export class SkillManager {
  readonly registry: SkillRegistry;
  readonly loader: SkillLoader;
  readonly router: SkillRouter;
  readonly runtime: SkillRuntime;

  private skillsDir: string;
  private initialized = false;

  constructor(toolRegistry: ToolRegistry, config: SkillManagerConfig = {}) {
    this.skillsDir = config.skillsDir || path.resolve(process.cwd(), 'skills');
    this.registry = new SkillRegistry();
    this.loader = new SkillLoader();
    this.router = new SkillRouter(this.registry);
    this.runtime = new SkillRuntime(toolRegistry, config.workspace);

    if (config.disabledSkills?.length) {
      this.registry.applyDisabledList(config.disabledSkills);
    }
  }

  // ─── 生命周期 ───

  /**
   * 初始化：扫描目录 + 注册所有 Skill
   */
  initialize(): number {
    if (this.initialized) {
      logger.warn('[SKILL-MANAGER] 已初始化，跳过');
      return this.registry.count();
    }

    const skills = this.loader.scanDirectory(this.skillsDir);
    for (const skill of skills) {
      this.registry.register(skill);
    }

    this.initialized = true;
    const count = this.registry.count();
    logger.info({ count, skillsDir: this.skillsDir }, '[SKILL-MANAGER] 初始化完成');
    return count;
  }

  /**
   * 重新加载所有 Skill（热加载）
   */
  reload(): number {
    this.registry.reset();
    this.initialized = false;
    return this.initialize();
  }

  // ─── 匹配 ───

  /**
   * 匹配用户输入 → 返回匹配结果
   */
  match(input: string, options?: { currentFile?: string; workspace?: string }): RouteResult {
    return this.router.route(input, options);
  }

  // ─── 执行 ───

  /**
   * 执行指定的 Skill
   */
  async execute(
    skill: SkillDefinition,
    options?: {
      userInput?: string;
      signal?: AbortSignal;
    },
  ): Promise<SkillResult> {
    return this.runtime.execute(skill, options);
  }

  /**
   * 匹配并执行（一步到位）
   */
  async matchAndExecute(
    input: string,
    options?: {
      currentFile?: string;
      workspace?: string;
      signal?: AbortSignal;
    },
  ): Promise<{ match: RouteResult; result?: SkillResult }> {
    const match = this.match(input, options);

    if (!match.match || !match.matchedSkill) {
      return { match };
    }

    const result = await this.execute(match.matchedSkill, {
      userInput: input,
      signal: options?.signal,
    });

    return { match, result };
  }

  // ─── 上下文注入 ───

  /**
   * 使用 Runtime 的 PromptCompiler + ContextManager 编译完整 prompt
   */
  async compileSkillPrompt(
    skill: SkillDefinition,
    options?: {
      userInput?: string;
      signal?: AbortSignal;
    },
  ): Promise<{ compiled: string; tokens: number }> {
    const { compiled } = await this.runtime.compilePrompt(skill, options);
    return { compiled, tokens: Math.ceil(compiled.length / 4) };
  }

  // ─── Hook 管理 ───

  registerHook(hook: SkillHook): void {
    this.runtime.registerHook(hook);
  }

  // ─── 查询 ───

  listSkills(): SkillDefinition[] {
    return this.registry.list();
  }

  getSkill(name: string): SkillDefinition | undefined {
    return this.registry.get(name);
  }

  getTraces(limit = 50) {
    return this.runtime.getTraces(limit);
  }

  getCircuitBreakerStatus() {
    return this.runtime.getCircuitBreakerStatus();
  }

  // ─── CLI 辅助命令 ───

  get cliCommands() {
    return {
      'skills:list': {
        description: '列出所有已注册的 Skill',
        handler: () => {
          const skills = this.listSkills();
          if (skills.length === 0) return '没有已注册的 Skill';
          return skills.map(s =>
            `  ${s.manifest.name} v${s.manifest.version} [${s.manifest.type}] - ${s.manifest.description}`
          ).join('\n');
        },
      },
      'skills:reload': {
        description: '重新加载所有 Skill',
        handler: () => {
          const count = this.reload();
          return `已重新加载 ${count} 个 Skill`;
        },
      },
      'skills:traces': {
        description: '查看最近 Skill 执行记录',
        handler: () => {
          const traces = this.getTraces(10);
          if (traces.length === 0) return '暂无执行记录';
          return traces.map(t =>
            `  [${t.status}] ${t.skillName} - ${t.durationMs}ms, ${t.tokensUsed} tokens`
          ).join('\n');
        },
      },
    };
  }
}
