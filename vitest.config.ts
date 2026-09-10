import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      exclude: ['packages/*/src/index.ts'],
      include: ['packages/*/src/**/*.ts'],
      provider: 'v8',
      reporter: ['text', 'html'],
      thresholds: {
        branches: 94.3,
        functions: 98.7,
        lines: 97.3,
        statements: 96.3,
      },
    },
    environment: 'node',
    globals: true,
    include: ['golden/**/*.test.ts', 'packages/*/src/**/*.test.ts', 'scripts/**/*.test.ts'],
    passWithNoTests: false,
    testTimeout: 15_000,
  },
});
