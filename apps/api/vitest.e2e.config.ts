import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// End-to-end tests: boot the real Nest application and exercise it over HTTP
// against a real PostgreSQL database. These REQUIRE `pnpm db:up` first.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.e2e.spec.ts'],
    root: './',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // A shared database makes parallel suites non-deterministic.
    fileParallelism: false,
  },
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
