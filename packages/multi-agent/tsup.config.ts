import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'index.ts',
  },
  format: ['esm'],
  target: 'es2022',
  dts: true,
  sourcemap: true,
  clean: true,
  outDir: 'dist',
  // 不打包任何 node_modules 依赖(包括 workspace 包)
  skipNodeModulesBundle: true,
  noExternal: [],
  external: [/@aipack-ai/],
});
