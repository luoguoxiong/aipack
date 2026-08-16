// esbuild 构建配置：把 ESM 依赖 bundle 成 VSCode 扩展宿主可加载的 CJS 单文件。
// 仅 'vscode' 不打进 bundle（由 VSCode 注入）。

import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

/** @type {esbuild.BuildOptions} */
const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  format: 'cjs', // VSCode 扩展宿主用 require
  platform: 'node',
  target: 'node18',
  sourcemap: true,
  minify: false, // 调试期不压缩
  external: ['vscode'], // 仅 vscode 不打进 bundle
  logLevel: 'info',
  // aipack-coding 内部动态 import('@aipack-ai/memory')，esbuild 会静态化 bundle
  banner: {
    js: '/* @aipack-ai/vscode-coding bundle (CJS) */',
  },
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('[esbuild] watching...');
} else {
  await esbuild.build(options);
  console.log('[esbuild] build done → dist/extension.js');
}
