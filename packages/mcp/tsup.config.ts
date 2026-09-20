import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'index.ts',
    'server/stdio-entry': 'src/server/stdio-entry.ts',
  },
  format: ['esm'],
  target: 'es2022',
  dts: true,
  sourcemap: true,
  clean: true,
  outDir: 'dist',
  skipNodeModulesBundle: true,
});
