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
  skipNodeModulesBundle: true,
});
