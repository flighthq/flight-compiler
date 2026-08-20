import type {
  CompilerInventoryFailureCode,
  PackageExportLane,
  PackageInventory,
} from '../../compiler-types/src/index.js';
import { isCompilerInventoryFailure } from './compilerInventoryFailure.js';
import { getPackageInventoryRootExportLane, resolvePackageExportLane } from './flightPackageExportLane.js';

describe('getPackageInventoryRootExportLane', () => {
  it('returns the root lane and fails loudly when the manifest has none', () => {
    const rootLane = createPackageExportLane('.');
    const contractLane = createPackageExportLane('./contract');
    const inventory = createPackageInventory([contractLane, rootLane]);

    expect(getPackageInventoryRootExportLane(inventory)).toBe(rootLane);
    expectInventoryFailure(
      () => getPackageInventoryRootExportLane(createPackageInventory([contractLane])),
      'missing-package-export',
    );
  });
});

describe('resolvePackageExportLane', () => {
  it('resolves root and subpath lanes and rejects unsupported, unknown, or unaccounted identities', () => {
    const rootLane = createPackageExportLane('.');
    const contractLane = createPackageExportLane('./contract');
    const inventoryByName = new Map([['@flighthq/types', createPackageInventory([rootLane, contractLane])]]);

    expect(resolvePackageExportLane(inventoryByName, '@flighthq/types')).toBe(rootLane);
    expect(resolvePackageExportLane(inventoryByName, '@flighthq/types/contract')).toBe(contractLane);
    expectInventoryFailure(
      () => resolvePackageExportLane(inventoryByName, 'typescript'),
      'unsupported-package-specifier',
    );
    expectInventoryFailure(() => resolvePackageExportLane(inventoryByName, '@flighthq/missing'), 'unknown-package');
    expectInventoryFailure(
      () => resolvePackageExportLane(inventoryByName, '@flighthq/types/private'),
      'missing-package-export',
    );
  });

  it('treats a configured package scope as literal text', () => {
    const lane = createPackageExportLane('.');
    const inventoryByName = new Map([['@flight.hq/types', createPackageInventory([lane])]]);

    expect(resolvePackageExportLane(inventoryByName, '@flight.hq/types', '@flight.hq')).toBe(lane);
    expectInventoryFailure(
      () => resolvePackageExportLane(inventoryByName, '@flightXhq/types', '@flight.hq'),
      'unsupported-package-specifier',
    );
  });
});

function createPackageExportLane(entry: string): PackageExportLane {
  return {
    conditions: [],
    entry,
    exportConflicts: [],
    exports: [],
    source: `packages/types/src/${entry === '.' ? 'index' : entry.slice(2)}.ts`,
    specifier: entry === '.' ? '@flighthq/types' : `@flighthq/types/${entry.slice(2)}`,
  };
}

function createPackageInventory(exportLanes: PackageExportLane[]): PackageInventory {
  return {
    bins: [],
    dependencies: [],
    directory: 'packages/types',
    exclusion: null,
    exportLanes,
    hostFacts: { dependencies: [], imports: [] },
    imports: [],
    name: '@flighthq/types',
    sdkExposures: [],
    sdkIncluded: false,
    sourceFiles: 0,
    testFiles: 0,
    version: '0.0.0',
  };
}

function expectInventoryFailure(run: () => unknown, code: CompilerInventoryFailureCode): void {
  let failure: unknown;
  try {
    run();
  } catch (error) {
    failure = error;
  }
  expect(isCompilerInventoryFailure(failure)).toBe(true);
  expect(failure).toMatchObject({ code, kind: 'compiler-inventory' });
}
