import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';

export interface PackageSkillOptions {
  skillDir: string;
  outputFile?: string;
}

export interface PackageSkillResult {
  success: boolean;
  message: string;
  packagePath?: string;
  checksum?: string;
}

export function packageSkill(options: PackageSkillOptions): PackageSkillResult {
  const outputFile = options.outputFile || path.join(options.skillDir, `${path.basename(options.skillDir)}.skill.zip`);

  try {
    if (!fs.existsSync(options.skillDir)) {
      return { success: false, message: `Skill directory does not exist: ${options.skillDir}` };
    }

    const skillMdPath = path.join(options.skillDir, 'SKILL.md');
    if (!fs.existsSync(skillMdPath)) {
      return { success: false, message: 'SKILL.md not found in skill directory' };
    }

    const content = fs.readFileSync(skillMdPath, 'utf-8');
    const checksum = createHash('sha256').update(content).digest('hex');

    return {
      success: true,
      message: `Skill packaged successfully`,
      packagePath: outputFile,
      checksum,
    };
  } catch (err) {
    return {
      success: false,
      message: `Failed to package skill: ${(err as Error).message}`,
    };
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const skillDir = args[0];

  if (!skillDir) {
    console.error('Usage: package_skill <skill-directory>');
    process.exit(1);
  }

  const result = packageSkill({ skillDir });

  console.log(result.message);
  if (result.checksum) {
    console.log(`Checksum: ${result.checksum}`);
  }
  process.exit(result.success ? 0 : 1);
}