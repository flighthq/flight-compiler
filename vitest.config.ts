import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
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
    passWithNoTests: false,
  },
});
