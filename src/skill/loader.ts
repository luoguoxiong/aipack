import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger';
import type { SkillDefinition, SkillManifest } from './types';

const SKILL_MANIFEST_FILE = 'skill.yaml';
const SKILL_PROMPT_FILE = 'SKILL.md';
const SKILL_HANDLER_FILE = 'handler.ts';

/**
 * Skill Loader — 目录扫描 + 文件解析
 */
export class SkillLoader {
  /**
   * 扫描目录，返回所有发现的 Skill 定义
   */
  scanDirectory(skillsDir: string): SkillDefinition[] {
    const absDir = path.resolve(skillsDir);
    logger.info({ skillsDir: absDir }, '[SKILL-LOADER] 开始扫描技能目录');

    if (!fs.existsSync(absDir)) {
      logger.warn({ skillsDir: absDir }, '[SKILL-LOADER] 技能目录不存在');
      return [];
    }

    const entries = fs.readdirSync(absDir, { withFileTypes: true });
    const skills: SkillDefinition[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const skillDir = path.join(absDir, entry.name);
      const skill = this.loadSkill(skillDir);
      if (skill) {
        skills.push(skill);
      }
    }

    logger.info({ count: skills.length, skillsDir: absDir }, '[SKILL-LOADER] 扫描完成');
    return skills;
  }

  /**
   * 从指定目录加载单个 Skill
   */
  loadSkill(skillDir: string): SkillDefinition | null {
    try {
      const manifestPath = path.join(skillDir, SKILL_MANIFEST_FILE);
      const promptPath = path.join(skillDir, SKILL_PROMPT_FILE);
      const handlerPath = path.join(skillDir, SKILL_HANDLER_FILE);

      // 至少需要 manifest 或 prompt 之一
      const hasManifest = fs.existsSync(manifestPath);
      const hasPrompt = fs.existsSync(promptPath);

      if (!hasManifest && !hasPrompt) {
        logger.warn({ skillDir }, '[SKILL-LOADER] 技能目录缺少 skill.yaml 或 SKILL.md，跳过');
        return null;
      }

      // 解析 manifest
      let manifest: SkillManifest;
      if (hasManifest) {
        manifest = this.parseManifest(manifestPath);
      } else {
        // 从目录名推断基本信息
        manifest = {
          name: path.basename(skillDir),
          version: '1.0.0',
          type: 'action',
          description: '',
        };
      }

      // 读取 prompt
      let promptMd = '';
      if (hasPrompt) {
        promptMd = fs.readFileSync(promptPath, 'utf-8');
      }

      // 验证 handler 是否存在
      const handlerExists = fs.existsSync(handlerPath);

      return {
        manifest,
        promptMd,
        handlerPath: handlerExists ? handlerPath : undefined,
        sourceDir: skillDir,
        registeredAt: Date.now(),
      };
    } catch (err) {
      logger.error({ skillDir, error: (err as Error).message }, '[SKILL-LOADER] 加载技能失败');
      return null;
    }
  }

  /**
   * 解析 skill.yaml（简化版 YAML 解析）
   * 避免引入额外依赖，支持 Phase 1 的基本结构
   */
  private parseManifest(manifestPath: string): SkillManifest {
    const raw = fs.readFileSync(manifestPath, 'utf-8');
    const parsed = this.parseSimpleYaml(raw);

    const manifest: SkillManifest = {
      name: (parsed.name as string) || 'unnamed',
      version: (parsed.version as string) || '1.0.0',
      type: (parsed.type as SkillManifest['type']) || 'action',
      description: (parsed.description as string) || '',
      author: parsed.author as string | undefined,
    };

    // trigger
    if (parsed.trigger) {
      const t = parsed.trigger as Record<string, unknown>;
      manifest.trigger = {
        keywords: t.keywords as string[] | undefined,
        file_patterns: t.file_patterns as string[] | undefined,
        priority: typeof t.priority === 'number' ? t.priority : 0,
      };
    }

    // context
    if (parsed.context) {
      const c = parsed.context as Record<string, unknown>;
      manifest.context = {
        required: this.normalizeArray(c.required) ?? this.normalizeArray(c.include) ?? undefined,
        optional: this.normalizeArray(c.optional) ?? undefined,
        exclude: this.normalizeArray(c.exclude) ?? undefined,
        max_tokens: typeof c.max_tokens === 'number' ? c.max_tokens : undefined,
      };
    }

    // context（兼容顶级简短写法）
    if (parsed.context_include) {
      manifest.context = manifest.context || {};
      manifest.context.required = this.normalizeArray(parsed.context_include) ?? manifest.context.required;
    }
    if (parsed.context_max_tokens !== undefined) {
      manifest.context = manifest.context || {};
      manifest.context.max_tokens = parsed.context_max_tokens as number;
    }

    // tools
    if (parsed.tools) {
      const t = parsed.tools as Record<string, unknown>;
      manifest.tools = {
        allowed: t.allowed as string[] | undefined,
      };
    }

    // runtime
    if (parsed.runtime) {
      const r = parsed.runtime as Record<string, unknown>;
      manifest.runtime = {
        timeout: typeof r.timeout === 'number' ? r.timeout : undefined,
        retry: typeof r.retry === 'number' ? r.retry : undefined,
        max_output_chars: typeof r.max_output_chars === 'number' ? r.max_output_chars : undefined,
      };
    }

    // permission
    if (parsed.permission) {
      // 暂不完整解析，保持原始对象
      manifest.permission = parsed.permission as SkillManifest['permission'];
    }

    return manifest;
  }

  /**
   * 极简 YAML 解析器（递归下降，支持嵌套对象和数组）
   */
  private parseSimpleYaml(raw: string): Record<string, unknown> {
    const lines = raw.split('\n')
      .map((l, idx) => ({
        indent: l.search(/\S/),
        text: l.trim(),
        lineNo: idx + 1,
      }))
      .filter(l => l.text.length > 0 && !l.text.startsWith('#'));

    const [result] = this.buildYamlNode(lines, 0, -1);
    return result;
  }

  private buildYamlNode(
    lines: Array<{ indent: number; text: string; lineNo: number }>,
    startIdx: number,
    parentIndent: number,
  ): [Record<string, unknown>, number] {
    const node: Record<string, unknown> = {};
    let i = startIdx;

    while (i < lines.length) {
      const line = lines[i];

      // 缩进回退到父级或以上 → 返回给上层
      if (i > startIdx && line.indent <= parentIndent) break;

      // ── 顶层的孤立列表项（无 key） ── 跳过
      if (line.text.startsWith('- ')) {
        i++;
        continue;
      }

      const colonIdx = line.text.indexOf(':');
      if (colonIdx <= 0) { i++; continue; }

      const key = line.text.slice(0, colonIdx).trim();
      const valueStr = line.text.slice(colonIdx + 1).trim();

      if (valueStr) {
        // key: value
        node[key] = this.parseYamlValue(valueStr);
        i++;
      } else {
        // key:（嵌套结构）
        const nextLine = i + 1 < lines.length ? lines[i + 1] : null;

        if (nextLine && nextLine.indent > line.indent && nextLine.text.startsWith('- ')) {
          // 数组: 收集所有连续的 - item
          const list: string[] = [];
          let j = i + 1;
          while (j < lines.length && lines[j].indent > line.indent && lines[j].text.startsWith('- ')) {
            list.push(lines[j].text.slice(2).replace(/^['"]|['"]$/g, ''));
            j++;
          }
          node[key] = list;
          i = j;
        } else if (nextLine && nextLine.indent > line.indent) {
          // 嵌套对象: 递归下降
          const [childNode, nextIdx] = this.buildYamlNode(lines, i + 1, line.indent);
          node[key] = childNode;
          i = nextIdx;
        } else {
          // 空值 key（无子节点）
          node[key] = {};
          i++;
        }
      }
    }

    return [node, i];
  }

  private parseYamlValue(raw: string): unknown {
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    if (/^\d+$/.test(raw)) return parseInt(raw, 10);
    if (/^\d+\.\d+$/.test(raw)) return parseFloat(raw);
    if (raw.startsWith('[') && raw.endsWith(']')) {
      return raw.slice(1, -1).split(',').map(v => v.trim().replace(/^['"]|['"]$/g, ''));
    }
    return raw.replace(/^['"]|['"]$/g, '');
  }

  /**
   * 将未知类型安全地转为 string[]，处理 YAML 解析出的各种边缘情况
   */
  private normalizeArray(value: unknown): string[] | null {
    if (Array.isArray(value)) {
      return value.filter((v): v is string => typeof v === 'string');
    }
    if (typeof value === 'string') {
      return [value];
    }
    return null;
  }
}
