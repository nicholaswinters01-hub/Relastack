import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// Unit tests: fast, isolated, no external dependencies. These must pass
// without Docker or a database running.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    root: './',
  },
  // NestJS relies on decorator metadata, which esbuild (Vitest's default
  // transformer) does not emit. SWC does.
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
