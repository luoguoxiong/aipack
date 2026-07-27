import type { SkillDefinition, SkillContext, SkillMatch } from './types';

export interface CompileOptions {
  context: SkillContext;
  userInput?: string;
  match?: SkillMatch;
  toolDescriptions?: string[];
}

export interface CompiledPrompt {
  system: string;
  tokens: number;
}

/**
 * Prompt Compiler — 独立的 Prompt 编译模块
 *
 * 职责：
 * 1. 解析 SKILL.md Frontmatter 和 Markdown
 * 2. 注入 Context Manager 的输出
 * 3. 按 allowed_tools 注入可用 Tool 列表
 * 4. 组装为最终 System Prompt
 * 5. 按 token 预算截断
 */
export class PromptCompiler {
  /**
   * 编译完整的 System Prompt
   */
  compile(skill: SkillDefinition, options: CompileOptions): CompiledPrompt {
    const parts: string[] = [];
    const { context, userInput, match, toolDescriptions } = options;

    // Phase 1: Parse — 解析 SKILL.md（移除 Frontmatter，保留 Markdown 正文）
    const parsedInstructions = this.parseInstructions(skill.promptMd);

    // Phase 2: Inject Context — 合并 Context Manager 的输出
    const contextBlock = this.buildContextBlock(context);

    // Phase 3: Bind Tools — 按 allowed_tools 注入可用 Tool 列表
    const toolsBlock = this.buildToolsBlock(skill, toolDescriptions);

    // 组装
    if (parsedInstructions) {
      parts.push(parsedInstructions);
    }
    if (contextBlock) {
      parts.push(contextBlock);
    }
    if (toolsBlock) {
      parts.push(toolsBlock);
    }
    if (userInput) {
      parts.push(`## User Request\n${userInput}`);
    }

    // 触发信息
    if (match) {
      parts.push(`[Triggered by: ${match.triggerType} (level ${match.level})]`);
    }

    const result = parts.join('\n\n');
    const tokens = Math.ceil(result.length / 4);

    return { system: result, tokens };
  }

  /**
   * 解析 SKILL.md:
   * - 移除可能的 YAML Frontmatter (--- ... ---)
   * - 移除 Frontmatter 中的元数据字段
   * - Section 级别重组
   */
  private parseInstructions(mdContent: string): string {
    if (!mdContent) return '';

    let content = mdContent.trim();

    // 移除 YAML Frontmatter (--- ... ---)
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n/);
    if (frontmatterMatch) {
      content = content.slice(frontmatterMatch[0].length).trim();
    }

    return content;
  }

  /**
   * 构建 Context 块
   */
  private buildContextBlock(context: SkillContext): string {
    const lines: string[] = [];

    if (context.files.length > 0) {
      lines.push('## Context Files');
      for (const file of context.files) {
        lines.push(file);
      }
    }

    if (context.memory.length > 0) {
      lines.push('## Memory Context');
      for (const mem of context.memory) {
        lines.push(mem);
      }
    }

    if (context.summary) {
      lines.push('## Summary');
      lines.push(context.summary);
    }

    if (context.truncated) {
      lines.push('\n> 注意：部分上下文因超出 token 预算已被截断');
    }

    return lines.join('\n');
  }

  /**
   * 构建 Tool 列表块
   */
  private buildToolsBlock(skill: SkillDefinition, toolDescriptions?: string[]): string {
    const allowed = skill.manifest.tools?.allowed;

    if (!allowed && !toolDescriptions) return '';

    const lines: string[] = ['## Available Tools'];

    if (allowed && toolDescriptions) {
      // 只保留 allowed 列表中的工具描述
      for (const toolName of allowed) {
        const desc = toolDescriptions.find(d => d.startsWith(toolName));
        if (desc) {
          lines.push(`- ${desc}`);
        } else {
          lines.push(`- ${toolName}`);
        }
      }
    } else if (allowed) {
      lines.push(allowed.map(t => `- ${t}`).join('\n'));
    } else if (toolDescriptions) {
      lines.push(toolDescriptions.map(t => `- ${t}`).join('\n'));
    }

    return lines.join('\n');
  }
}
