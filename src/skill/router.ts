import path from 'path';
import { logger } from '../utils/logger';
import type { SkillDefinition, SkillMatch, RouteResult } from './types';
import { SkillRegistry } from './registry';

/**
 * Skill Router — 四级匹配
 *
 * Level 0: 显式调用（如 /review）
 * Level 1: 规则匹配（关键词）
 * Level 2: Context Match（文件/环境）
 * Level 3: LLM Router（由 AI 模型选择最佳 Skill）
 */
export class SkillRouter {
  private registry: SkillRegistry;

  constructor(registry: SkillRegistry) {
    this.registry = registry;
  }

  /**
   * 路由入口 — 执行 Level 0-2 匹配
   * @returns 最佳匹配结果
   */
  route(input: string, options?: { currentFile?: string; workspace?: string }): RouteResult {
    const allMatches = this.matchAll(input, options);
    const best = this.registry.findBestMatch(allMatches);

    if (best) {
      const matchedSkill = this.registry.get(best.skillName);
      logger.info(
        { skillName: best.skillName, level: best.level, confidence: best.confidence, triggerType: best.triggerType },
        '[SKILL-ROUTER] 匹配成功',
      );
      return { match: best, matchedSkill: matchedSkill || null };
    }

    return { match: null, matchedSkill: null };
  }

  /**
   * Level 3: LLM Router — 当 Level 0-2 未匹配时，让 LLM 从候选中选择
   *
   * @param input 用户输入
   * @param llmCall 调用 LLM 的函数，接收 prompt，返回选定 Skill 名称或 null
   * @returns LLM 选择的 Skill 匹配结果
   */
  async llmRoute(
    input: string,
    llmCall: (prompt: string) => Promise<string | null>,
  ): Promise<RouteResult> {
    const candidates = this.getCandidates(input);

    if (candidates.length === 0) {
      return { match: null, matchedSkill: null };
    }

    // 只有一个候选时直接返回（省一次 LLM 调用）
    if (candidates.length === 1) {
      const skill = this.registry.get(candidates[0].name);
      if (skill) {
        const match: SkillMatch = {
          skillName: skill.manifest.name,
          confidence: candidates[0].score,
          level: 3,
          triggerType: 'llm',
          priority: skill.manifest.trigger?.priority ?? 0,
        };
        return { match, matchedSkill: skill };
      }
      return { match: null, matchedSkill: null };
    }

    // 构建 LLM 选择 prompt
    const prompt = [
      '从以下 Skill 中选择一个最适合处理用户请求的 Skill。',
      '只返回 Skill 名称，不要额外文字。如果都不合适，返回 "none"。',
      '',
      '## 候选 Skill',
      candidates.map((c, i) => `${i + 1}. ${c.name}: ${c.description}`).join('\n'),
      '',
      `## 用户请求\n${input}`,
      '',
      '选中的 Skill 名称:',
    ].join('\n');

    const selected = await llmCall(prompt);
    if (!selected || selected.toLowerCase() === 'none') {
      return { match: null, matchedSkill: null };
    }

    // 尝试匹配名称（模糊匹配）
    const matched = candidates.find(
      c => c.name.toLowerCase() === selected.toLowerCase() ||
           selected.toLowerCase().includes(c.name.toLowerCase()),
    );

    if (!matched) {
      return { match: null, matchedSkill: null };
    }

    const skill = this.registry.get(matched.name);
    if (skill) {
      const match: SkillMatch = {
        skillName: skill.manifest.name,
        confidence: matched.score,
        level: 3,
        triggerType: 'llm',
        priority: skill.manifest.trigger?.priority ?? 0,
      };
      logger.info({ skillName: match.skillName, level: 3 }, '[SKILL-ROUTER] LLM 匹配成功');
      return { match, matchedSkill: skill };
    }

    return { match: null, matchedSkill: null };
  }

  /**
   * 获取候选 Skill 列表（用于 Level 3 路由）
   */
  getCandidates(input: string): Array<{ name: string; description: string; score: number }> {
    const allSkills = this.registry.list();
    const candidates: Array<{ name: string; description: string; score: number }> = [];

    for (const skill of allSkills) {
      let score = 0;
      const trigger = skill.manifest.trigger;

      // 关键词命中加分
      if (trigger?.keywords) {
        const lowerInput = input.toLowerCase();
        for (const kw of trigger.keywords) {
          if (lowerInput.includes(kw.toLowerCase())) {
            score += 0.3;
          }
        }
      }

      // 有 description 的基础分
      if (skill.manifest.description) {
        score += 0.1;
      }

      if (score > 0) {
        candidates.push({
          name: skill.manifest.name,
          description: skill.manifest.description,
          score: Math.min(score, 1),
        });
      }
    }

    // 按分数降序，取 top 5
    return candidates.sort((a, b) => b.score - a.score).slice(0, 5);
  }

  /**
   * 执行全量匹配（Level 0-2）
   */
  private matchAll(input: string, options?: { currentFile?: string; workspace?: string }): SkillMatch[] {
    const matches: SkillMatch[] = [];
    const skills = this.registry.list();

    for (const skill of skills) {
      const match = this.matchSingle(skill, input, options);
      if (match) {
        matches.push(match);
      }
    }

    return matches;
  }

  /**
   * 对单个 Skill 执行三级匹配
   */
  private matchSingle(
    skill: SkillDefinition,
    input: string,
    options?: { currentFile?: string; workspace?: string },
  ): SkillMatch | null {
    const triggers = skill.manifest.trigger;
    const name = skill.manifest.name;

    // ── Level 0: 显式调用 ──
    // 匹配 "/skillName" 或 "/name" 格式
    const explicitPattern = new RegExp(`^/${name}(\\s|$)`);
    if (explicitPattern.test(input.trim())) {
      return {
        skillName: name,
        confidence: 1.0,
        level: 0,
        triggerType: 'explicit',
        priority: triggers?.priority ?? 0,
      };
    }

    // ── Level 1: 规则匹配 ──
    if (triggers?.keywords && triggers.keywords.length > 0) {
      const lowerInput = input.toLowerCase();
      const matchedKeywords = triggers.keywords.filter(kw =>
        lowerInput.includes(kw.toLowerCase()),
      );

      if (matchedKeywords.length > 0) {
        return {
          skillName: name,
          confidence: Math.min(0.3 + matchedKeywords.length * 0.15, 0.8),
          level: 1,
          triggerType: 'keyword',
          priority: triggers?.priority ?? 0,
        };
      }
    }

    // ── Level 2: Context Match ──
    if (triggers?.file_patterns && triggers.file_patterns.length > 0 && options?.currentFile) {
      const currentFile = options.currentFile;
      for (const pattern of triggers.file_patterns) {
        // 简单的 glob 匹配（仅支持 **/*.ext 和 *.ext 模式）
        if (this.matchFilePattern(currentFile, pattern)) {
          return {
            skillName: name,
            confidence: 0.7,
            level: 2,
            triggerType: 'file',
            priority: triggers?.priority ?? 0,
          };
        }
      }
    }

    return null;
  }

  /**
   * 简化版 glob 文件模式匹配
   */
  private matchFilePattern(filePath: string, pattern: string): boolean {
    const basename = path.basename(filePath);
    const ext = path.extname(filePath);

    // **/*.ext → 检查扩展名
    if (pattern.startsWith('**/*.')) {
      const targetExt = pattern.slice(5);
      return ext === targetExt;
    }

    // *.ext → 只检查 basename
    if (pattern.startsWith('*.')) {
      const targetExt = pattern.slice(1);
      return basename.endsWith(targetExt);
    }

    // 精确文件名匹配
    if (pattern.includes('*')) {
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
      return regex.test(basename);
    }

    return basename === pattern;
  }
}
