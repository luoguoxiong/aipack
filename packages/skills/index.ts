/**
 * aipack-skills —— aipack Agent Skills 插件
 *
 * 对齐 Agent Skills 开放规范（SKILL.md + YAML frontmatter），
 * 通过 @aipack-ai/agent 的 Extension 插件机制零侵入接入 Runtime。
 *
 * 能力：
 *   - SKILL.md 目录扫描 / frontmatter 解析 / 多源加载（user → project → extraPaths）
 *   - 渐进式披露：system prompt 只注入 name + description 目录，全文经内置
 *     skill 工具按需获取，运行时零 fs 依赖
 *   - /skill:name 显式展开（expandSkillCommand）
 *
 * 快速接入：
 *   import { createSkillsPlugin } from '@aipack-ai/skills';
 *   const plugin = createSkillsPlugin({ load: { cwd: process.cwd() } });
 *   const runtime = createRuntime({ ..., extensions: plugin.extensions });
 */

// ─── 插件入口 ───────────────────────────────────────────────────────
export { SkillsExtension, createSkillsPlugin } from './src/extension';
export type {
  SkillsExtensionOptions,
  SkillsPluginOptions,
  SkillsPlugin,
} from './src/extension';

// ─── 契约层（纯函数，零 fs）─────────────────────────────────────────
export {
  validateSkill,
  formatSkillsSection,
  createSkillTool,
  expandSkillCommand,
} from './src/core';

// ─── 加载器（Node only）─────────────────────────────────────────────
export { loadSkills, parseSkillMarkdown } from './src/loader';
export type { ParseSkillMarkdownOptions } from './src/loader';

// ─── 类型 ───────────────────────────────────────────────────────────
export type { Skill, SkillDiagnostic, LoadSkillsOptions } from './src/types';

// ─── 从 @aipack-ai/agent 再导出常用类型（方便单一 import） ──────────
export type { Extension, Tool, ToolResult } from '@aipack-ai/agent';
