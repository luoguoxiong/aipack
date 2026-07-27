import { logger } from '../utils/logger';
import type { SkillDefinition, SkillManifest, SkillMatch } from './types';

/**
 * Skill Registry — 管理 Skill 元信息
 *
 * Phase 1: 内存 Map 存储
 * Phase 2 迁移到 SQLite（需要 persistent 场景时）
 */
export class SkillRegistry {
  private skills: Map<string, SkillDefinition> = new Map();
  private disabledNames: Set<string> = new Set();

  register(skill: SkillDefinition): void {
    if (this.disabledNames.has(skill.manifest.name)) {
      logger.info({ skillName: skill.manifest.name }, '[SKILL] 跳过已禁用的 Skill');
      return;
    }

    const existing = this.skills.get(skill.manifest.name);
    if (existing) {
      logger.warn(
        { skillName: skill.manifest.name, oldVersion: existing.manifest.version, newVersion: skill.manifest.version },
        '[SKILL] 覆盖已注册的 Skill',
      );
    }

    this.skills.set(skill.manifest.name, skill);
    logger.info(
      { skillName: skill.manifest.name, version: skill.manifest.version, type: skill.manifest.type },
      '[SKILL] 已注册',
    );
  }

  unregister(name: string): boolean {
    const existed = this.skills.delete(name);
    if (existed) {
      logger.info({ skillName: name }, '[SKILL] 已注销');
    }
    return existed;
  }

  get(name: string): SkillDefinition | undefined {
    return this.skills.get(name);
  }

  has(name: string): boolean {
    return this.skills.has(name);
  }

  list(): SkillDefinition[] {
    return Array.from(this.skills.values());
  }

  listNames(): string[] {
    return Array.from(this.skills.keys());
  }

  count(): number {
    return this.skills.size;
  }

  disable(name: string): void {
    this.disabledNames.add(name);
    this.skills.delete(name);
    logger.info({ skillName: name }, '[SKILL] 已禁用');
  }

  enable(name: string): void {
    this.disabledNames.delete(name);
    logger.info({ skillName: name }, '[SKILL] 已启用（需重新加载）');
  }

  isDisabled(name: string): boolean {
    return this.disabledNames.has(name);
  }

  getDisabledNames(): string[] {
    return Array.from(this.disabledNames);
  }

  /**
   * 按优先级排序的查找
   * 优先级规则：Level 越低越优先 > priority 降序 > confidence 降序
   */
  findBestMatch(matches: SkillMatch[]): SkillMatch | null {
    if (matches.length === 0) return null;

    return matches.sort((a, b) => {
      // Level 越低越优先（0 = 显式调用最高优先级）
      if (a.level !== b.level) return a.level - b.level;
      // 同 Level 按 priority 降序
      if (a.priority !== b.priority) return b.priority - a.priority;
      // 同 priority 按 confidence 降序
      return b.confidence - a.confidence;
    })[0];
  }

  /**
   * 批量设置禁用列表（从配置加载）
   */
  applyDisabledList(names: string[]): void {
    this.disabledNames = new Set(names);
    for (const name of names) {
      this.skills.delete(name);
    }
  }

  reset(): void {
    this.skills.clear();
    this.disabledNames.clear();
    logger.info('[SKILL] Registry 已重置');
  }
}
