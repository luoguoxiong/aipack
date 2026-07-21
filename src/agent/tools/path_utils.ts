import path from 'path';
import fs from 'fs/promises';

export function isUnder(targetPath: string, directory: string): boolean {
  const resolvedTarget = path.resolve(targetPath);
  const resolvedDir = path.resolve(directory);
  const relative = path.relative(resolvedDir, resolvedTarget);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

export function resolveWorkspacePath(
  inputPath: string,
  workspace?: string,
  allowedDir?: string,
  extraAllowedDirs: string[] = [],
  extraAllowedFiles: string[] = [],
  includeMediaDir = true,
): string {
  const base = workspace || process.cwd();
  let resolved: string;

  if (path.isAbsolute(inputPath)) {
    resolved = path.normalize(inputPath);
  } else {
    resolved = path.resolve(base, inputPath);
  }

  resolved = path.normalize(resolved);

  if (allowedDir) {
    const allowedRoots = [path.resolve(allowedDir), ...extraAllowedDirs.map((d) => path.resolve(d))];
    const allowedFiles = extraAllowedFiles.map((f) => path.resolve(f));

    const isAllowed = allowedRoots.some((root) => isUnder(resolved, root)) ||
      allowedFiles.some((f) => resolved === f);

    if (!isAllowed) {
      throw new Error(`Path is not within allowed directory: ${inputPath}`);
    }
  }

  return resolved;
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
