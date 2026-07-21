import fs from 'fs';
import path from 'path';
import { truncateText } from './helpers.js';

export const WORKSPACE_PROMPT_MAX_CHARS = 32_000;

export function workspacePromptFile(workspace: string, name: string): string {
  return path.join(workspace, 'prompts', `${name}.md`);
}

export function loadWorkspacePromptOverride(
  filePath: string,
  opts: { max_chars?: number } = {},
): { text: string | null; original_chars: number } {
  const maxChars = opts.max_chars ?? WORKSPACE_PROMPT_MAX_CHARS;
  try {
    const text = fs.readFileSync(filePath, 'utf-8').trimEnd();
    if (text) {
      const originalChars = text.length;
      return { text: truncateText(text, maxChars), original_chars: originalChars };
    }
  } catch {
    // ignore
  }
  return { text: null, original_chars: 0 };
}

export function hasWorkspacePromptOverride(filePath: string): boolean {
  const { text } = loadWorkspacePromptOverride(filePath);
  return text !== null;
}

export function initializeWorkspacePrompt(filePath: string, defaultPrompt: string): boolean {
  try {
    if (fs.existsSync(filePath)) {
      const stat = fs.statSync(filePath);
      if (!stat.isFile() || fs.readFileSync(filePath, 'utf-8').trim()) {
        return false;
      }
    }
  } catch {
    return false;
  }

  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, defaultPrompt + '\n', 'utf-8');
  return true;
}
