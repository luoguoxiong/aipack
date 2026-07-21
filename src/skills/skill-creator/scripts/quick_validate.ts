import fs from 'fs';
import path from 'path';

export interface ValidateResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export function validateSkill(skillDir: string): ValidateResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!fs.existsSync(skillDir)) {
    errors.push(`Skill directory does not exist: ${skillDir}`);
    return { valid: false, errors, warnings };
  }

  const skillMdPath = path.join(skillDir, 'SKILL.md');
  if (!fs.existsSync(skillMdPath)) {
    errors.push('SKILL.md is required');
  } else {
    const content = fs.readFileSync(skillMdPath, 'utf-8');
    if (!content.trim()) {
      errors.push('SKILL.md is empty');
    }

    if (!content.includes('# ')) {
      warnings.push('SKILL.md should have a title (e.g., # Skill Name)');
    }
  }

  const files = fs.readdirSync(skillDir);
  const hasScript = files.some(f => f.endsWith('.ts') || f.endsWith('.js'));
  const hasConfig = files.some(f => f.endsWith('.json'));

  if (!hasScript && !hasConfig) {
    warnings.push('Skill has no scripts or configuration files');
  }

  for (const file of files) {
    const filePath = path.join(skillDir, file);
    const stat = fs.statSync(filePath);
    if (stat.size > 1024 * 1024) {
      warnings.push(`File ${file} is larger than 1MB`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const skillDir = args[0];

  if (!skillDir) {
    console.error('Usage: quick_validate <skill-directory>');
    process.exit(1);
  }

  const result = validateSkill(skillDir);

  if (result.warnings.length > 0) {
    console.log('Warnings:');
    for (const warning of result.warnings) {
      console.log(`  - ${warning}`);
    }
  }

  if (result.errors.length > 0) {
    console.error('Errors:');
    for (const error of result.errors) {
      console.error(`  - ${error}`);
    }
    process.exit(1);
  }

  console.log('Skill is valid');
  process.exit(0);
}