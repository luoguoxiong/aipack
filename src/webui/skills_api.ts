import path from 'path';
import fs from 'fs';

export interface SkillEntry {
  name: string;
  description: string;
  source: string;
  available: boolean;
  unavailable_reason: string | null;
}

export interface SkillRequirements {
  bins: string[];
  env: string[];
  missing_bins: string[];
  missing_env: string[];
}

export interface SkillDetail extends SkillEntry {
  requirements: SkillRequirements;
  raw_markdown: string;
}

export interface SkillsPayload {
  skills: SkillEntry[];
}

function listSkillsFromDir(dir: string, source: string): Array<{ name: string; source: string }> {
  const results: Array<{ name: string; source: string }> = [];
  try {
    if (!fs.existsSync(dir)) return results;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        // Subdirectory-based skill: name/SKILL.md
        const skillMdPath = path.join(dir, entry.name, 'SKILL.md');
        if (fs.existsSync(skillMdPath)) {
          results.push({ name: entry.name, source });
        }
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        // Flat file skill: name.md
        results.push({ name: entry.name.slice(0, -3), source });
      }
    }
  } catch {
    // ignore
  }
  return results;
}

function getSkillMetadata(skillPath: string): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(skillPath)) return null;
    const content = fs.readFileSync(skillPath, 'utf-8');
    const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!frontmatterMatch) return null;
    const metadata: Record<string, unknown> = {};
    const lines = frontmatterMatch[1].split('\n');
    for (const line of lines) {
      const colonIndex = line.indexOf(':');
      if (colonIndex > 0) {
        const key = line.slice(0, colonIndex).trim();
        const value = line.slice(colonIndex + 1).trim().replace(/^["']|["']$/g, '');
        metadata[key] = value;
      }
    }
    return metadata;
  } catch {
    return null;
  }
}

function getSkillRequirements(_skillPath: string): SkillRequirements {
  return {
    bins: [],
    env: [],
    missing_bins: [],
    missing_env: [],
  };
}

function loadSkillMarkdown(skillPath: string): string {
  try {
    if (!fs.existsSync(skillPath)) return '';
    return fs.readFileSync(skillPath, 'utf-8');
  } catch {
    return '';
  }
}

function getBuiltinSkillsDir(): string {
  // Try several locations for the builtin skills directory
  const cwd = process.cwd();
  const candidates = [
    // 1. skills/ in project root
    path.resolve(cwd, 'skills'),
    // 2. Python project skills (for comparison/testing)
    path.resolve(cwd, '..', 'nanobot-main', 'nanobot', 'skills'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates[0];
}

class SkillsLoader {
  private workspacePath: string;
  private builtinSkillsDir: string;
  private disabledSkills: Set<string>;

  constructor(workspacePath: string, options?: { disabledSkills?: Set<string>; builtinSkillsDir?: string }) {
    this.workspacePath = workspacePath;
    this.builtinSkillsDir = options?.builtinSkillsDir || getBuiltinSkillsDir();
    this.disabledSkills = options?.disabledSkills || new Set();
  }

  listSkills(filterUnavailable = false): Array<{ name: string; source: string }> {
    // Load from workspace (.nanobot/skills/)
    const workspaceSkillsDir = path.join(this.workspacePath, '.nanobot', 'skills');
    const workspaceSkills = listSkillsFromDir(workspaceSkillsDir, 'workspace');

    // Load from builtin skills directory
    const builtinSkills = listSkillsFromDir(this.builtinSkillsDir, 'builtin');

    // Merge, workspace takes priority over builtin for same name
    const seen = new Set<string>();
    const results: Array<{ name: string; source: string }> = [];
    for (const skill of workspaceSkills) {
      if (!seen.has(skill.name)) {
        seen.add(skill.name);
        results.push(skill);
      }
    }
    for (const skill of builtinSkills) {
      if (!seen.has(skill.name)) {
        seen.add(skill.name);
        results.push(skill);
      }
    }

    if (filterUnavailable) {
      return results.filter((s) => !this.disabledSkills.has(s.name));
    }
    return results;
  }

  getSkillPath(name: string): string | null {
    // Check workspace first
    const workspaceDir = path.join(this.workspacePath, '.nanobot', 'skills');
    // Try subdirectory format: name/SKILL.md
    const workspaceSubdir = path.join(workspaceDir, name, 'SKILL.md');
    if (fs.existsSync(workspaceSubdir)) return workspaceSubdir;
    // Try flat file: name.md
    const workspaceFlat = path.join(workspaceDir, `${name}.md`);
    if (fs.existsSync(workspaceFlat)) return workspaceFlat;

    // Check builtin
    const builtinSubdir = path.join(this.builtinSkillsDir, name, 'SKILL.md');
    if (fs.existsSync(builtinSubdir)) return builtinSubdir;
    const builtinFlat = path.join(this.builtinSkillsDir, `${name}.md`);
    if (fs.existsSync(builtinFlat)) return builtinFlat;

    return null;
  }

  getSkillMetadata(name: string): Record<string, unknown> | null {
    const skillPath = this.getSkillPath(name);
    if (!skillPath) return null;
    return getSkillMetadata(skillPath);
  }

  getSkillAvailability(name: string): [boolean, string | null] {
    if (this.disabledSkills.has(name)) {
      return [false, 'disabled'];
    }
    const skillPath = this.getSkillPath(name);
    if (!skillPath) {
      return [false, 'not_found'];
    }
    return [true, null];
  }

  getSkillRequirements(name: string): SkillRequirements {
    const skillPath = this.getSkillPath(name);
    if (!skillPath) return { bins: [], env: [], missing_bins: [], missing_env: [] };
    return getSkillRequirements(skillPath);
  }

  loadSkill(name: string): string | null {
    const skillPath = this.getSkillPath(name);
    if (!skillPath) return null;
    return loadSkillMarkdown(skillPath);
  }
}

function description(metadata: Record<string, unknown> | null, fallback: string): string {
  if (!metadata) return fallback;
  const value = metadata.description;
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function skillPayload(
  loader: SkillsLoader,
  entry: { name: string; source: string },
): SkillEntry {
  const { name } = entry;
  const metadata = loader.getSkillMetadata(name);
  const [available, unavailableReason] = loader.getSkillAvailability(name);
  return {
    name,
    description: description(metadata, name),
    source: entry.source,
    available,
    unavailable_reason: unavailableReason,
  };
}

export function webuiSkillsPayload(
  workspacePath: string,
  options?: { disabledSkills?: Set<string> },
): SkillsPayload {
  const loader = new SkillsLoader(workspacePath, {
    disabledSkills: options?.disabledSkills,
  });
  const entries = loader.listSkills(false).sort((a, b) => {
    const aWorkspace = a.source !== 'workspace' ? 1 : 0;
    const bWorkspace = b.source !== 'workspace' ? 1 : 0;
    if (aWorkspace !== bWorkspace) return aWorkspace - bWorkspace;
    return a.name.localeCompare(b.name);
  });
  return {
    skills: entries.map((entry) => skillPayload(loader, entry)),
  };
}

export function webuiSkillDetailPayload(
  workspacePath: string,
  name: string,
  options?: { disabledSkills?: Set<string> },
): SkillDetail | null {
  const loader = new SkillsLoader(workspacePath, {
    disabledSkills: options?.disabledSkills,
  });
  const entries = loader.listSkills(false);
  const entry = entries.find((item) => item.name === name);
  if (!entry) return null;
  return {
    ...skillPayload(loader, entry),
    requirements: loader.getSkillRequirements(name),
    raw_markdown: loader.loadSkill(name) || '',
  };
}
