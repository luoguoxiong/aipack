import fs from 'fs';
import path from 'path';
import type { SkillDefinition, SkillContext } from './types';

/**
 * Context Manager — 独立的上下文管理模块
 *
 * 职责：
 * 1. 解析 Skill 声明的 context 需求（required/optional/exclude）
 * 2. 从文件系统和 memory 中读取实际内容
 * 3. 计算 token 用量，按 budget 截断
 * 4. 输出结构化的 SkillContext
 */
export class ContextManager {
  private workspace: string;

  constructor(workspace?: string) {
    this.workspace = workspace || process.cwd();
  }

  /**
   * 为指定 Skill 准备上下文
   */
  async prepare(skill: SkillDefinition, options?: {
    signal?: AbortSignal;
  }): Promise<SkillContext> {
    const contextDef = skill.manifest.context;
    const maxTokens = contextDef?.max_tokens || 8000;
    const files: string[] = [];
    const memory: string[] = [];
    let totalTokens = 0;
    let truncated = false;

    // 1. 处理 required 文件路径
    if (contextDef?.required) {
      for (const fileRef of contextDef.required) {
        if (options?.signal?.aborted) break;

        const filePath = this.resolvePath(fileRef);
        const content = await this.readFileIfExists(filePath);
        if (content !== null) {
          const fileEntry = `\`${fileRef}\`:\n${content.slice(0, 2000)}`;
          const fileTokens = Math.ceil(fileEntry.length / 4);

          if (totalTokens + fileTokens > maxTokens) {
            truncated = true;
            files.push(`\`${fileRef}\`: [已截断 — 超出 token 预算]`);
            totalTokens += 50;
          } else {
            files.push(fileEntry);
            totalTokens += fileTokens;
          }
        } else {
          files.push(`\`${fileRef}\`: [文件未找到]`);
          totalTokens += 10;
        }
      }
    }

    // 2. 处理 optional 文件路径（只在预算充足时读取）
    if (contextDef?.optional && !truncated) {
      for (const fileRef of contextDef.optional) {
        if (options?.signal?.aborted) break;

        const filePath = this.resolvePath(fileRef);
        const content = await this.readFileIfExists(filePath);
        if (content !== null) {
          const fileEntry = `\`${fileRef}\`:\n${content.slice(0, 1000)}`;
          const fileTokens = Math.ceil(fileEntry.length / 4);

          if (totalTokens + fileTokens > maxTokens) {
            truncated = true;
            break;
          }
          files.push(fileEntry);
          totalTokens += fileTokens;
        }
      }
    }

    return {
      files,
      memory,
      summary: '',
      tokens: totalTokens,
      size: totalTokens,
      cost: totalTokens,
      truncated,
    };
  }

  /**
   * 解析路径：支持 git.diff, changed_files 等特殊引用
   */
  private resolvePath(fileRef: string): string {
    // git.diff → 不读取文件，留空（由外部工具准备）
    if (fileRef === 'git.diff' || fileRef === 'changed_files') {
      return '';
    }
    // 相对于 workspace 解析
    if (!path.isAbsolute(fileRef)) {
      return path.join(this.workspace, fileRef);
    }
    return fileRef;
  }

  /**
   * 安全读取文件（忽略不存在的文件）
   */
  private async readFileIfExists(filePath: string): Promise<string | null> {
    if (!filePath) return null;
    try {
      await fs.promises.access(filePath, fs.constants.R_OK);
      return await fs.promises.readFile(filePath, 'utf-8');
    } catch {
      return null;
    }
  }

  updateWorkspace(workspace: string): void {
    this.workspace = workspace;
  }
}
