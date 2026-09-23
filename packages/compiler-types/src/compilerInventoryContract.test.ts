import type {
  FlightPackageEligibilityOptions,
  FlightPackageEligibilityPlan,
  FlightPackageEligibilitySubsetOptions,
  FlightPackageEligibilitySubsetPlan,
  PackageExportLane,
  PackageInventory,
  UpstreamInventory,
} from './compilerInventoryContract.js';

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
      bins: [{ name: 'math', target: './dist/cli.js' }],
      dependencies: [],
      directory: 'packages/math',
      environment: 'web',
      exclusion: null,
      exportLanes: [lane],
      hostFacts: { dependencies: [], imports: [] },
      imports: [],
      name: '@flighthq/math',
      sdkExposures: [{ sdkLane: '@flighthq/sdk', target: '@flighthq/math' }],
      sdkIncluded: true,
      sourceFiles: 2,
      testFiles: 1,
      version: '0.0.0',
    };
    const inventory: UpstreamInventory = {
      packages: [packageInventory],
      schema: 'flight-compiler-inventory/2',
      summary: {
        exportConflicts: 1,
        exportLanes: 1,
        excludedPackages: 0,
        exports: 1,
        hostDependencies: 0,
        hostImports: 0,
        packages: 1,
        productionImports: 0,
        rootExports: 1,
        sourceFiles: 2,
        testFiles: 1,
      },
      upstreamCommit: '0'.repeat(40),
    };
    const eligibilityOptions: FlightPackageEligibilityOptions = {
      environment: packageInventory.environment,
      packages: inventory.packages,
      selectedPackageNames: [packageInventory.name],
    };
    const eligibilityPlan: FlightPackageEligibilityPlan = {
      eligiblePackageNames: eligibilityOptions.selectedPackageNames,
      environment: eligibilityOptions.environment ?? null,
      schema: 'flight-compiler-package-eligibility/1',
    };
    const eligibilitySubsetOptions: FlightPackageEligibilitySubsetOptions = {
      candidatePackageNames: eligibilityOptions.selectedPackageNames,
      environment: eligibilityOptions.environment,
      packages: eligibilityOptions.packages,
    };
    const eligibilitySubsetPlan: FlightPackageEligibilitySubsetPlan = {
      environment: eligibilitySubsetOptions.environment ?? null,
      excludedRoots: [],
      includedPackageNames: eligibilitySubsetOptions.candidatePackageNames,
      schema: 'flight-compiler-package-eligibility-subset/1',
    };

    expect(inventory.packages[0]?.exportLanes[0]).toBe(lane);
    expect(inventory.summary).toMatchObject({ exportConflicts: 1, exports: 1 });
    expect(eligibilityPlan.environment).toBe('web');
    expect(eligibilitySubsetPlan.includedPackageNames).toEqual(['@flighthq/math']);
  });
});
