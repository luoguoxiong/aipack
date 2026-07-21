import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const PROJECT_ROOT = path.resolve(__dirname, '../../');

export function expandHome(p: string): string {
  if (p.startsWith('~')) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

export function getWorkspacePath(workspace: string): string {
  return path.resolve(expandHome(workspace));
}

export function getProjectConfigDir(): string {
  return path.join(PROJECT_ROOT, '.nanobot');
}
