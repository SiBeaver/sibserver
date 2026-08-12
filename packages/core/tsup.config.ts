import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: !process.env.SKIP_DTS,
  clean: true,
  sourcemap: true,
  external: ['node:*'],
  splitting: false,
});
