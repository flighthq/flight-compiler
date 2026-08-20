import type { PackageHostFacts, PackageInventory } from '../../compiler-types/src/index.js';
import { isCompilerInventoryFailure } from './compilerInventoryFailure.js';
import { analyzeFlightPackageExclusions } from './flightPackageExclusion.js';

describe('analyzeFlightPackageExclusions', () => {
  it('derives deterministic exclusions from complete evidence without mutating package inventories', () => {
    const tool = createPackageInventory('@flighthq/tool-capture', {
      dependencies: [{ kind: 'playwright', specifier: '@playwright/test' }],
      imports: [
        { kind: 'playwright', specifier: '@playwright/test' },
        { kind: 'node', specifier: 'node:path' },
      ],
    });
    const math = createPackageInventory('@flighthq/math');
    const before = structuredClone([tool, math]);

    const exclusions = analyzeFlightPackageExclusions({ packages: [tool, math] });

    expect([...exclusions]).toEqual([
      [
        '@flighthq/tool-capture',
        {
          evidence: {
            bins: [{ name: 'capture', target: './dist/cli.js' }],
            hostDependencies: [{ kind: 'playwright', specifier: '@playwright/test' }],
            hostImports: [
              { kind: 'playwright', specifier: '@playwright/test' },
              { kind: 'node', specifier: 'node:path' },
            ],
            sdkExposures: [],
          },
          reason:
            'Tooling package with 1 bin lane, no SDK exposure, and production host use limited to Node and Playwright.',
          rule: 'node-playwright-tooling',
        },
      ],
    ]);
    expect([tool, math]).toEqual(before);
  });

  it('returns no exclusions for packages without tooling or Playwright evidence', () => {
    expect(analyzeFlightPackageExclusions({ packages: [createPackageInventory('@flighthq/math')] })).toEqual(new Map());
  });

  it('rejects every partial evidence boundary with a stable drift failure', () => {
    const completeHostFacts: PackageHostFacts = {
      dependencies: [{ kind: 'playwright', specifier: '@playwright/test' }],
      imports: [
        { kind: 'node', specifier: 'node:fs' },
        { kind: 'playwright', specifier: '@playwright/test' },
      ],
    };
    const cases: PackageInventory[] = [
      { ...createPackageInventory('@flighthq/no-bin', completeHostFacts), bins: [] },
      {
        ...createPackageInventory('@flighthq/sdk-tool', completeHostFacts),
        sdkExposures: [{ sdkLane: '@flighthq/sdk', target: '@flighthq/sdk-tool' }],
      },
      createPackageInventory('@flighthq/no-node', {
        ...completeHostFacts,
        imports: [{ kind: 'playwright', specifier: '@playwright/test' }],
      }),
      createPackageInventory('@flighthq/no-playwright-dependency', {
        ...completeHostFacts,
        dependencies: [],
      }),
      createPackageInventory('@flighthq/no-playwright-import', {
        ...completeHostFacts,
        imports: [{ kind: 'node', specifier: 'node:fs' }],
      }),
      createPackageInventory('@flighthq/unsupported-dependency', {
        ...completeHostFacts,
        dependencies: [...completeHostFacts.dependencies, { kind: 'electron', specifier: 'electron' }],
      }),
      createPackageInventory('@flighthq/unsupported-import', {
        ...completeHostFacts,
        imports: [...completeHostFacts.imports, { kind: 'tauri', specifier: '@tauri-apps/api' }],
      }),
    ];

    for (const packageInventory of cases) {
      expectInventoryFailure(() => analyzeFlightPackageExclusions({ packages: [packageInventory] }));
    }
  });

  it('locks an optional expected package set so a complete match cannot appear or disappear silently', () => {
    const tool = createPackageInventory('@flighthq/tool-capture', {
      dependencies: [{ kind: 'playwright', specifier: '@playwright/test' }],
      imports: [
        { kind: 'node', specifier: 'node:fs' },
        { kind: 'playwright', specifier: '@playwright/test' },
      ],
    });

    expect(
      analyzeFlightPackageExclusions({ expectedPackageNames: ['@flighthq/tool-capture'], packages: [tool] }).has(
        '@flighthq/tool-capture',
      ),
    ).toBe(true);
    expectInventoryFailure(() => analyzeFlightPackageExclusions({ expectedPackageNames: [], packages: [tool] }));
    expectInventoryFailure(() =>
      analyzeFlightPackageExclusions({
        expectedPackageNames: ['@flighthq/tool-capture'],
        packages: [createPackageInventory('@flighthq/math')],
      }),
    );
  });
});

function createPackageInventory(
  name: string,
  hostFacts: PackageHostFacts = { dependencies: [], imports: [] },
): PackageInventory {
  const directoryName = name.slice(name.lastIndexOf('/') + 1);
  return {
    bins: name.includes('tool') || name.includes('bin') ? [{ name: 'capture', target: './dist/cli.js' }] : [],
    dependencies: [],
    directory: `packages/${directoryName}`,
    exclusion: null,
    exportLanes: [],
    hostFacts,
    imports: [],
    name,
    sdkExposures: [],
    sdkIncluded: false,
    sourceFiles: 0,
    testFiles: 0,
    version: '0.0.0',
  };
}

function expectInventoryFailure(run: () => unknown): void {
  let failure: unknown;
  try {
    run();
  } catch (error) {
    failure = error;
  }
  expect(isCompilerInventoryFailure(failure)).toBe(true);
  expect(failure).toMatchObject({ code: 'package-exclusion-drift', kind: 'compiler-inventory' });
}
