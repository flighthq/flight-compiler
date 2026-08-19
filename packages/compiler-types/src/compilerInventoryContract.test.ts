import type { PackageExportLane, PackageInventory, UpstreamInventory } from './compilerInventoryContract.js';

describe('compiler inventory contracts', () => {
  it('compose package lanes, conflicts, runtime identity, and summary data without hidden behavior', () => {
    const lane: PackageExportLane = {
      conditions: [{ condition: 'default', source: 'packages/math/src/index.ts', target: './dist/index.js' }],
      entry: '.',
      exportConflicts: [{ name: 'value', sources: ['packages/math/src/a.ts', 'packages/math/src/b.ts'] }],
      exports: [
        {
          fingerprint: 'sha256:value',
          kind: 'function',
          name: 'createValue',
          runtime: true,
          source: 'packages/math/src/value.ts',
        },
      ],
      source: 'packages/math/src/index.ts',
      specifier: '@flighthq/math',
    };
    const packageInventory: PackageInventory = {
      dependencies: [],
      directory: 'packages/math',
      exportLanes: [lane],
      name: '@flighthq/math',
      sdkExposures: [{ sdkLane: '@flighthq/sdk', target: '@flighthq/math' }],
      sdkIncluded: true,
      sourceFiles: 2,
      testFiles: 1,
      version: '0.0.0',
    };
    const inventory: UpstreamInventory = {
      packages: [packageInventory],
      schema: 'flight-compiler-inventory/1',
      summary: {
        exportConflicts: 1,
        exportLanes: 1,
        exports: 1,
        packages: 1,
        rootExports: 1,
        sourceFiles: 2,
        testFiles: 1,
      },
      upstreamCommit: '0'.repeat(40),
    };

    expect(inventory.packages[0]?.exportLanes[0]).toBe(lane);
    expect(inventory.summary).toMatchObject({ exportConflicts: 1, exports: 1 });
  });
});
