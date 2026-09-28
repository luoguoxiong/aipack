import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'index.ts',
    cli: 'src/cli.ts',
  },
  format: ['esm'],
  target: 'es2022',
  dts: true,
  sourcemap: true,
  clean: true,
  outDir: 'dist',
  skipNodeModulesBundle: true,
  // cli 入口的 shebang 由 esbuild 的 txt 语法在源文件首行处理（见 src/cli.ts）
  banner: {
    js: '#!/usr/bin/env node',
  },
});
