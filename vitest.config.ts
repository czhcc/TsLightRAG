import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['internal/**/*.test.ts', 'apps/**/*.test.ts', 'apps/**/*.test.tsx', 'tests/integration/**/*.test.ts'],
    maxWorkers: 3, testTimeout: 15_000, hookTimeout: 20_000,
    restoreMocks: true,
    coverage: {
      provider: 'v8', reporter: ['text', 'json-summary', 'json'],
      include: ['apps/server/src/storage/**/*.ts', 'apps/server/src/indexing/**/*.ts', 'apps/server/src/retrieval/**/*.ts'],
      exclude: ['**/*.test.ts'],
      thresholds: { lines: 85, branches: 80 },
    },
  },
});
