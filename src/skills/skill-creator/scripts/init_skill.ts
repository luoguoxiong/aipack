import fs from 'fs';
import path from 'path';

export interface InitSkillOptions {
  name: string;
  description?: string;
  author?: string;
  outputDir: string;
}

export interface InitSkillResult {
  success: boolean;
  message: string;
  skillPath?: string;
}

export function initSkill(options: InitSkillOptions): InitSkillResult {
  const skillDir = path.join(options.outputDir, options.name);

  try {
    if (fs.existsSync(skillDir)) {
      return { success: false, message: `Skill directory already exists: ${skillDir}` };
    }

    fs.mkdirSync(skillDir, { recursive: true });

    const skillContent = `# ${options.name}

${options.description || ''}

## Usage

Describe how to use this skill.

## Configuration

Describe any configuration options.
`;

    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skillContent);

    return {
      success: true,
      message: `Skill "${options.name}" created successfully`,
      skillPath: skillDir,
    };
  } catch (err) {
    return {
      success: false,
      message: `Failed to create skill: ${(err as Error).message}`,
    };
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const name = args[0];

  if (!name) {
    console.error('Usage: init_skill <skill-name>');
    process.exit(1);
  }

  const result = initSkill({
    name,
    outputDir: process.cwd(),
  });

  console.log(result.message);
  process.exit(result.success ? 0 : 1);
}