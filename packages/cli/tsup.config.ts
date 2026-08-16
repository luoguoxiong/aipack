import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    cli: 'src/cli.ts',
    index: 'index.ts',
  },
  format: ['esm'],
  target: 'es2022',
  dts: true,
  sourcemap: true,
  clean: true,
  outDir: 'dist',
  skipNodeModulesBundle: true,
  external: ['@aipack-ai/agent', '@aipack-ai/agent/ai'],
});
