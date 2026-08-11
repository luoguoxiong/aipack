/**
 * observability-web（并入 observability-server 的静态资源）Vite 配置
 * - 开发：5175 端口，/api、/metrics、/traces 代理到收集服务(默认 :8787)
 * - 生产：vite build 产出 ../dist/public，由 observability-server 启动时自动托管
 *   （config.ts 默认 staticDir 定位到该目录，访问 http://localhost:8787 即面板）
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';

const webRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: webRoot, // 明确 root，避免从包根目录运行时解析不到 index.html
  plugins: [react()],
  base: './', // 相对路径，任意子路径部署均可
  server: {
    port: 5175,
    strictPort: false,
    proxy: {
      '/api': { target: 'http://localhost:8787', changeOrigin: true },
      '/metrics': { target: 'http://localhost:8787', changeOrigin: true },
      '/traces': { target: 'http://localhost:8787', changeOrigin: true },
    },
  },
  build: {
    outDir: '../dist/public',
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
});
