import path from 'node:path';

import { defineConfig } from 'vitest/config';

// Serves one mutated module from memory for a single Vitest run. The mutated text is never written
// to disk, so an interrupt at any moment leaves the working tree exactly as it was — the property
// that makes it safe to run this instrument inside a repository someone is editing.
//
// `scripts/mutationRun.ts` sets both variables and reads the run's exit status; nothing else uses
// this configuration.
const mutationTarget = process.env.FLIGHT_MUTATION_TARGET;
const mutationSource = process.env.FLIGHT_MUTATION_SOURCE;
const resolvedTarget = mutationTarget ? path.resolve(mutationTarget) : undefined;

export default defineConfig({
  plugins: [
    {
      enforce: 'pre',
      load(id: string): string | undefined {
        if (!resolvedTarget || mutationSource === undefined) return undefined;
        return path.resolve(id.split('?', 1)[0] ?? id) === resolvedTarget
          ? Buffer.from(mutationSource, 'base64').toString('utf8')
          : undefined;
      },
      name: 'flight-mutation',
    },
  ],
  test: {
    environment: 'node',
    globals: true,
    passWithNoTests: false,
    testTimeout: 15_000,
  },
});
