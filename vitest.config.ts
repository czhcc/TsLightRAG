import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['internal/**/*.test.ts', 'apps/**/*.test.ts', 'apps/**/*.test.tsx', 'tests/integration/**/*.test.ts'],
    maxWorkers: 3, testTimeout: 15_000, hookTimeout: 20_000,
    restoreMocks: true,
  },
});
