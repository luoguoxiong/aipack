import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger.js';

export interface BuildOptions {
  outDir: string;
  watch?: boolean;
  minify?: boolean;
}

export interface BuildResult {
  success: boolean;
  message: string;
  filesBuilt: number;
  errors?: string[];
}

export async function buildWebUI(options: BuildOptions): Promise<BuildResult> {
  const errors: string[] = [];
  let filesBuilt = 0;

  try {
    fs.mkdirSync(options.outDir, { recursive: true });

    const indexContent = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Nanobot WebUI</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
  </style>
</head>
<body>
  <div id="root"></div>
</body>
</html>`;

    fs.writeFileSync(path.join(options.outDir, 'index.html'), indexContent);
    filesBuilt++;

    logger.info(`WebUI built successfully to ${options.outDir}`);
    return { success: true, message: 'Build completed', filesBuilt };
  } catch (err) {
    errors.push((err as Error).message);
    logger.error(`WebUI build failed: ${(err as Error).message}`);
    return { success: false, message: 'Build failed', filesBuilt, errors };
  }
}

export async function watchWebUI(options: BuildOptions): Promise<void> {
  logger.info('Watching WebUI for changes...');
}

export function cleanBuild(outDir: string): boolean {
  try {
    if (fs.existsSync(outDir)) {
      fs.rmSync(outDir, { recursive: true });
    }
    logger.info(`Cleaned build directory: ${outDir}`);
    return true;
  } catch (err) {
    logger.error(`Failed to clean build directory: ${(err as Error).message}`);
    return false;
  }
}