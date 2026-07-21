import fs from 'fs/promises';
import path from 'path';
import { logger } from '../utils/logger.js';

export interface Skill {
  name: string;
  description: string;
  content: string;
  tags: string[];
  version?: string;
}

export class SkillLoader {
  private skills: Map<string, Skill> = new Map();
  private skillDirs: string[] = [];

  addSkillDir(dir: string): void {
    this.skillDirs.push(dir);
  }

  async load(): Promise<void> {
    for (const dir of this.skillDirs) {
      try {
        await this.loadFromDir(dir);
      } catch (err) {
        logger.debug({ err, dir }, 'Failed to load skills from directory');
      }
    }
    logger.info({ count: this.skills.size }, 'Skills loaded');
  }

  private async loadFromDir(dir: string): Promise<void> {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        
        const skillDir = path.join(dir, entry.name);
        const skillMdPath = path.join(skillDir, 'SKILL.md');
        
        try {
          const content = await fs.readFile(skillMdPath, 'utf-8');
          const skill = this.parseSkill(entry.name, content);
          this.skills.set(skill.name, skill);
          logger.debug({ skill: skill.name }, 'Loaded skill');
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            logger.debug({ err, skill: entry.name }, 'Failed to load skill');
          }
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.debug({ err, dir }, 'Failed to read skill directory');
      }
    }
  }

  private parseSkill(name: string, content: string): Skill {
    const lines = content.split('\n');
    let description = '';
    const tags: string[] = [];
    
    let inFrontMatter = false;
    const frontMatter: Record<string, string> = {};
    
    if (lines[0]?.trim() === '---') {
      inFrontMatter = true;
      let i = 1;
      while (i < lines.length && lines[i].trim() !== '---') {
        const colonIndex = lines[i].indexOf(':');
        if (colonIndex > 0) {
          const key = lines[i].slice(0, colonIndex).trim();
          const value = lines[i].slice(colonIndex + 1).trim();
          frontMatter[key] = value;
        }
        i++;
      }
      if (frontMatter.description) {
        description = frontMatter.description;
      }
      if (frontMatter.tags) {
        tags.push(...frontMatter.tags.split(',').map(t => t.trim()));
      }
    }

    if (!description) {
      for (const line of lines) {
        if (line.startsWith('# ')) {
          description = line.slice(2).trim();
          break;
        }
      }
    }

    return {
      name,
      description: description || name,
      content,
      tags,
      version: frontMatter.version,
    };
  }

  getSkill(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  listSkills(): string[] {
    return Array.from(this.skills.keys());
  }

  getSkillsByTag(tag: string): Skill[] {
    return Array.from(this.skills.values()).filter(s => s.tags.includes(tag));
  }

  buildSkillPrompt(skillNames: string[]): string {
    const skills: Skill[] = [];
    for (const name of skillNames) {
      const skill = this.skills.get(name);
      if (skill) {
        skills.push(skill);
      }
    }
    
    if (skills.length === 0) return '';
    
    const sections = skills.map(s => `## ${s.name}\n\n${s.content}`);
    return `# Skills\n\n${sections.join('\n\n')}`;
  }

  size(): number {
    return this.skills.size;
  }
}
