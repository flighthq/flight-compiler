import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      exclude: ['packages/*/src/index.ts'],
      include: ['packages/*/src/**/*.ts'],
      provider: 'v8',
      reporter: ['text', 'html'],
      thresholds: {
        branches: 45,
        functions: 77,
        lines: 65,
        statements: 61,
      },
    },
    environment: 'node',
    globals: true,
    include: ['packages/*/src/**/*.test.ts', 'src/**/*.test.ts'],
    passWithNoTests: false,
  },
});
