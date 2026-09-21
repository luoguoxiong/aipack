/**
 * aipack-docs Vite 配置
 */
import { readFileSync } from 'fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

const pkg = JSON.parse(
  readFileSync(path.resolve(__dirname, 'package.json'), 'utf8'),
) as { version: string };

export default defineConfig({
  plugins: [react()],
  define: {
    // 版本号统一取自 package.json，避免文档里硬编码后与发布版本漂移
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  root: 'frontend',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
  server: {
    port: 5174,
    strictPort: false,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'frontend/src'),
    },
  },
});
