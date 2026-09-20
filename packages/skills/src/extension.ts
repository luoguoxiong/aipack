/**
 * Skills - Runtime 插件（Extension 接入）
 *
 * 通过 @aipack-ai/agent 的 Extension 机制零侵入接入 Runtime：
 *   1. apply 阶段：经 ExtensionContext.runtime 注册内置 skill 工具
 *      （模型可调用获取 skill 全文；执行走 Runtime 统一的工具通道）
 *   2. beforeModelCall 钩子：把 <available_skills> 目录段附加到 system prompt
 *      （渐进式披露：目录先行，全文按需拉取；基准 prompt 每次重建，不累积）
 *
 * 用法：
 *   const runtime = createRuntime({ ..., extensions: [new SkillsExtension(skills)] });
 *   // 或一站式（含文件加载）：
 *   const plugin = createSkillsPlugin({ load: { cwd } });
 *   const runtime = createRuntime({ ..., extensions: plugin.extensions });
 */

import { BaseExtension } from '@aipack-ai/agent';
import type { Extension, RuntimeHooks, ExtensionContext, Context } from '@aipack-ai/agent';
import type { Skill, SkillDiagnostic, LoadSkillsOptions } from './types';
import { validateSkill, formatSkillsSection, createSkillTool } from './core';
import { loadSkills } from './loader';

// ─── 插件选项 ──────────────────────────────────────────────────────

export interface SkillsExtensionOptions {
  /** skill 工具名（默认 'skill'） */
  toolName?: string;
  /** 是否注册内置 skill 工具（默认 true；关闭后仅注入目录段，全文获取由上层自理） */
  registerTool?: boolean;
  /** 是否注入 <available_skills> 目录段到 system prompt（默认 true） */
  injectPrompt?: boolean;
}

// ─── SkillsExtension ───────────────────────────────────────────────

export class SkillsExtension extends BaseExtension {
  readonly name = 'skills';

  private skills: Skill[];
  private options: SkillsExtensionOptions;

  constructor(skills: Skill[], options: SkillsExtensionOptions = {}) {
    super();
    this.skills = skills;
    this.options = options;
  }

  protected setup(hooks: RuntimeHooks, context: ExtensionContext): void {
    // 1. 过滤非法 skill（校验失败只告警不中断）
    const valid: Skill[] = [];
    for (const skill of this.skills) {
      const errors = validateSkill(skill);
      if (errors.length > 0) {
        console.warn(`[skills] "${skill.name}" 校验失败，已忽略: ${errors.join('; ')}`);
        continue;
      }
      valid.push(skill);
    }

    // 2. 注册内置 skill 工具（模型按需获取全文；执行走 Runtime 工具通道）
    if (this.options.registerTool !== false && valid.length > 0) {
      if (!context.runtime) {
        console.warn('[skills] ExtensionContext.runtime 不可用，跳过 skill 工具注册');
      } else {
        context.runtime.registerTool(
          createSkillTool(valid, { name: this.options.toolName }),
        );
      }
    }

    // 3. 注入 <available_skills> 目录段（渐进式披露；无可见 skill 时零开销）
    const visible = valid.filter(s => !s.disableModelInvocation);
    if (this.options.injectPrompt !== false && visible.length > 0) {
      const section = formatSkillsSection(visible);
      hooks.beforeModelCall.tapPromise('skills', async (ctx: Context): Promise<Context> => ({
        ...ctx,
        systemPrompt: ctx.systemPrompt ? `${ctx.systemPrompt}\n\n${section}` : section,
      }));
    }
  }
}

// ─── 一站式插件工厂 ────────────────────────────────────────────────

export interface SkillsPluginOptions extends SkillsExtensionOptions {
  /** 程序化提供的 skills（与 load 合并时 inline 优先） */
  skills?: Skill[];
  /** 文件加载选项（提供时调用 loadSkills） */
  load?: LoadSkillsOptions;
}

export interface SkillsPlugin {
  /** 合并后的全部 skills（含 disableModelInvocation） */
  skills: Skill[];
  /** 加载诊断（error / collision 等），供上层展示 */
  diagnostics: SkillDiagnostic[];
  /** 接入 Runtime 的扩展列表（无可用 skill 时为空数组，零开销） */
  extensions: Extension[];
}

/**
 * 一站式创建 skills 插件：文件加载（可选）+ inline 合并 + Extension 装配。
 *
 * 用法（aipack.config.js / CLI）：
 *   import { createSkillsPlugin } from '@aipack-ai/skills';
 *   const plugin = createSkillsPlugin({ load: { cwd } });
 *   export default { ..., extensions: plugin.extensions };
 */
export function createSkillsPlugin(options: SkillsPluginOptions = {}): SkillsPlugin {
  const loaded = options.load
    ? loadSkills(options.load)
    : { skills: [] as Skill[], diagnostics: [] as SkillDiagnostic[] };

  const skills = [...(options.skills ?? []), ...loaded.skills];
  const diagnostics: SkillDiagnostic[] = [...loaded.diagnostics];

  const extensions: Extension[] =
    skills.length > 0 ? [new SkillsExtension(skills, options)] : [];

  return { skills, diagnostics, extensions };
}
