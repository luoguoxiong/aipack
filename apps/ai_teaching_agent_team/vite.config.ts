/**
 * apps/ai_teaching_agent_team/vite.config.ts
 *
 * Vite 配置(前端 React 构建):
 *   - root: frontend/  (index.html 位于 frontend/)
 *   - build.outDir: ../dist/frontend  (产出到后端 dist 同级,供生产静态托管)
 *   - dev server: 5173,代理 /api → 后端 3001(避免跨域)
 *
 * 开发:pnpm --filter ai-teaching-agent-team dev  (concurrently 同时起后端 tsx watch + vite)
 * 生产:pnpm --filter ai-teaching-agent-team build  → vite build + tsc,再 serve 单端口
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  root: 'frontend',
  build: {
    outDir: '../dist/frontend',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
});
