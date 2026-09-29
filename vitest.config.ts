import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  resolve: {
    // Tests always run against package sources, never a stale dist/.
    alias: [
      { find: /^@dvo\/service$/, replacement: `${root}apps/service/src/index.ts` },
      { find: /^@dvo\/([a-z0-9-]+)$/, replacement: `${root}packages/$1/src/index.ts` },
    ],
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts', 'evals/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // Loopback test servers must never be routed through a corporate proxy.
    env: { NO_PROXY: '*', no_proxy: '*' },
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.ts'],
      exclude: ['packages/testkit/src/**', 'apps/service/src/main.ts', '**/index.ts'],
      reporter: ['text-summary', 'html', 'lcov'],
      thresholds: { lines: 80, functions: 80, branches: 70, statements: 80 },
    },
  },
});
