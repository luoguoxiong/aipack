/**
 * apps/ai_teaching_agent_team/scripts/build-functions.mjs
 *
 * 把 netlify/functions/*.ts 用 esbuild 打包为自包含 .mjs 输出到 netlify/functions-dist/。
 *
 * 为什么不用 Netlify 自带打包器(zisi):
 *   本应用依赖 pnpm workspace 包 agentpack(node_modules 中为 symlink)。
 *   zisi 对 pnpm symlink 依赖的解析不稳定,可能部署失败。
 *   这里用 esbuild 把 agentpack 及其依赖(@sinclair/typebox、partial-json)
 *   全部内联进单个函数文件,产出零外部依赖的函数(zisi 无需再解析 workspace 依赖)。
 *
 * 前置条件:pnpm --filter ai-teaching-agent-team build 已产出 dist/(函数 import 自 dist)。
 */
import { build } from 'esbuild';

await build({
  entryPoints: ['netlify/functions/config.ts', 'netlify/functions/teach.ts'],
  outdir: 'netlify/functions-dist',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  // 内联所有 npm 包(esbuild ≥0.24 默认 external,必须显式 bundle)
  packages: 'bundle',
  // node 内置模块(node:*)保持 external,由 Netlify 函数运行时提供
  outExtension: { '.js': '.mjs' },
  sourcemap: false,
  logLevel: 'info',
});
