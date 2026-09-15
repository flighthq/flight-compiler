import { defineConfig } from 'vitest/config';

const coverageEnabled = process.argv.some(
  (argument) => argument === '--coverage' || argument.startsWith('--coverage.'),
);

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
    // V8 instrumentation makes the graph/facade integration cases roughly twice as slow on a
    // saturated CI worker. Keep the ordinary test budget strict while giving the coverage gate a
    // bounded allowance for the same assertions.
    testTimeout: coverageEnabled ? 45_000 : 15_000,
  },
});
