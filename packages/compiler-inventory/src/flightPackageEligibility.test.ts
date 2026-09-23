import type {
  FlightPackageEligibilityFailure,
  FlightPackageEligibilityFailureCode,
  FlightPackageEligibilityOptions,
  FlightPackageEligibilityPackage,
  FlightPackageEligibilitySubsetOptions,
  FlightPackageEnvironment,
} from '../../compiler-types/src/index.js';
import {
  createFlightPackageEligibilityPlan,
  createFlightPackageEligibilitySubsetPlan,
  isFlightPackageEligibilityFailure,
} from './flightPackageEligibility.js';

describe('createFlightPackageEligibilityPlan', () => {
  it('creates a deterministic immutable internal dependency closure without target-language policy', () => {
    const packages = [
      createPackage('@flighthq/web', ['@flighthq/core'], 'web'),
      createPackage('@flighthq/core', []),
      createPackage('@flighthq/app', ['external-package', '@flighthq/web']),
    ];
    const options: FlightPackageEligibilityOptions = {
      environment: 'web',
      packages,
      selectedPackageNames: ['@flighthq/app'],
    };
    const snapshot = structuredClone(options);

    const plan = createFlightPackageEligibilityPlan(options);

    expect(plan).toEqual({
      eligiblePackageNames: ['@flighthq/app', '@flighthq/core', '@flighthq/web'],
      environment: 'web',
      schema: 'flight-compiler-package-eligibility/1',
    });
    expect(createFlightPackageEligibilityPlan({ ...options, packages: [...packages].reverse() })).toEqual(plan);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.eligiblePackageNames)).toBe(true);
    expect(options).toEqual(snapshot);
    expect(plan).not.toHaveProperty('target');
  });

  it('allows unmarked packages without a selection and marked packages only under an exact explicit selection', () => {
    expect(
      createFlightPackageEligibilityPlan({
        packages: [createPackage('@flighthq/core', [])],
        selectedPackageNames: ['@flighthq/core'],
      }),
    ).toEqual({
      eligiblePackageNames: ['@flighthq/core'],
      environment: null,
      schema: 'flight-compiler-package-eligibility/1',
    });
    expect(
      createFlightPackageEligibilityPlan({
        environment: 'capacitor',
        packages: [createPackage('@flighthq/mobile', [], 'capacitor')],
        selectedPackageNames: ['@flighthq/mobile'],
      }).eligiblePackageNames,
    ).toEqual(['@flighthq/mobile']);
  });

  it('reports an inspectable deterministic dependency conflict for an absent or different environment', () => {
    const packages = [
      createPackage('@flighthq/app', ['@flighthq/renderer']),
      createPackage('@flighthq/renderer', ['@flighthq/browser']),
      createPackage('@flighthq/browser', [], 'web'),
    ];

    const absent = captureFailure(() =>
      createFlightPackageEligibilityPlan({ packages, selectedPackageNames: ['@flighthq/app'] }),
    );
    expect(absent).toMatchObject({
      code: 'ineligible-package-environment',
      dependencyPath: ['@flighthq/app', '@flighthq/renderer', '@flighthq/browser'],
      kind: 'flight-package-eligibility',
      requiredEnvironment: 'web',
      selectedEnvironment: null,
      subject: '@flighthq/browser',
    });

    const different = captureFailure(() =>
      createFlightPackageEligibilityPlan({
        environment: 'node',
        packages: [...packages].reverse(),
        selectedPackageNames: ['@flighthq/app'],
      }),
    );
    expect(different).toMatchObject({
      code: 'ineligible-package-environment',
      dependencyPath: ['@flighthq/app', '@flighthq/renderer', '@flighthq/browser'],
      requiredEnvironment: 'web',
      selectedEnvironment: 'node',
      subject: '@flighthq/browser',
    });
    expect(Object.isFrozen(different.dependencyPath)).toBe(true);
  });

  it('rejects malformed packages and selections through stable failure codes', () => {
    const valid = createPackage('@flighthq/core', []);
    const cases: Array<{ code: FlightPackageEligibilityFailureCode; options: unknown }> = [
      { code: 'invalid-selection', options: null },
      { code: 'invalid-selection', options: { packages: [], selectedPackageNames: null } },
      { code: 'invalid-environment', options: { environment: 'native', packages: [], selectedPackageNames: [] } },
      { code: 'invalid-package', options: { packages: [null], selectedPackageNames: [] } },
      {
        code: 'invalid-package',
        options: { packages: [{ ...valid, dependencies: ['', ''] }], selectedPackageNames: [] },
      },
      {
        code: 'invalid-package',
        options: { packages: [{ ...valid, environment: 'native' }], selectedPackageNames: [] },
      },
      { code: 'duplicate-package', options: { packages: [valid, { ...valid }], selectedPackageNames: [] } },
      { code: 'invalid-selection', options: { packages: [valid], selectedPackageNames: ['', ''] } },
      {
        code: 'invalid-selection',
        options: { packages: [valid], selectedPackageNames: ['@flighthq/core', '@flighthq/core'] },
      },
      { code: 'unknown-package', options: { packages: [valid], selectedPackageNames: ['@flighthq/missing'] } },
    ];

    for (const testCase of cases) {
      expect(captureFailure(() => createFlightPackageEligibilityPlan(testCase.options as never))).toMatchObject({
        code: testCase.code,
        kind: 'flight-package-eligibility',
      });
    }
  });
});

describe('createFlightPackageEligibilitySubsetPlan', () => {
  it('excludes direct, dependent, and multi-hop roots with their first actionable environment path', () => {
    const packages = [
      createPackage('@flighthq/browser', [], 'web'),
      createPackage('@flighthq/core', []),
      createPackage('@flighthq/direct', ['@flighthq/browser']),
      createPackage('@flighthq/multi-hop', ['@flighthq/direct']),
      createPackage('@flighthq/safe', ['@flighthq/core']),
    ];

    expect(
      createFlightPackageEligibilitySubsetPlan({
        candidatePackageNames: ['@flighthq/safe', '@flighthq/multi-hop', '@flighthq/direct', '@flighthq/browser'],
        packages,
      }),
    ).toEqual({
      environment: null,
      excludedRoots: [
        {
          dependencyPath: ['@flighthq/browser'],
          name: '@flighthq/browser',
          requiredEnvironment: 'web',
          selectedEnvironment: null,
        },
        {
          dependencyPath: ['@flighthq/direct', '@flighthq/browser'],
          name: '@flighthq/direct',
          requiredEnvironment: 'web',
          selectedEnvironment: null,
        },
        {
          dependencyPath: ['@flighthq/multi-hop', '@flighthq/direct', '@flighthq/browser'],
          name: '@flighthq/multi-hop',
          requiredEnvironment: 'web',
          selectedEnvironment: null,
        },
      ],
      includedPackageNames: ['@flighthq/core', '@flighthq/safe'],
      schema: 'flight-compiler-package-eligibility-subset/1',
    });
  });

  it('deduplicates shared dependencies and is deterministic under every input reorder', () => {
    const packages = [
      createPackage('@flighthq/b', ['@flighthq/shared']),
      createPackage('@flighthq/shared', []),
      createPackage('@flighthq/a', ['external-package', '@flighthq/shared']),
    ];
    const options: FlightPackageEligibilitySubsetOptions = {
      candidatePackageNames: ['@flighthq/b', '@flighthq/a'],
      packages,
    };
    const expected = {
      environment: null,
      excludedRoots: [],
      includedPackageNames: ['@flighthq/a', '@flighthq/b', '@flighthq/shared'],
      schema: 'flight-compiler-package-eligibility-subset/1',
    };

    expect(createFlightPackageEligibilitySubsetPlan(options)).toEqual(expected);
    expect(
      createFlightPackageEligibilitySubsetPlan({
        candidatePackageNames: [...options.candidatePackageNames].reverse(),
        packages: [...packages]
          .reverse()
          .map((package_) => ({ ...package_, dependencies: [...package_.dependencies].reverse() })),
      }),
    ).toEqual(expected);
  });

  it('includes only unmarked or exactly matching closures for neutral and explicit environments', () => {
    const packages = [
      createPackage('@flighthq/core', []),
      createPackage('@flighthq/node-tool', [], 'node'),
      createPackage('@flighthq/web-app', ['@flighthq/web-renderer']),
      createPackage('@flighthq/web-renderer', [], 'web'),
    ];
    const candidatePackageNames = packages.map((package_) => package_.name);

    expect(createFlightPackageEligibilitySubsetPlan({ candidatePackageNames, packages })).toMatchObject({
      environment: null,
      excludedRoots: [
        { name: '@flighthq/node-tool', requiredEnvironment: 'node', selectedEnvironment: null },
        { name: '@flighthq/web-app', requiredEnvironment: 'web', selectedEnvironment: null },
        { name: '@flighthq/web-renderer', requiredEnvironment: 'web', selectedEnvironment: null },
      ],
      includedPackageNames: ['@flighthq/core'],
    });
    expect(
      createFlightPackageEligibilitySubsetPlan({ environment: 'web', candidatePackageNames, packages }),
    ).toMatchObject({
      environment: 'web',
      excludedRoots: [{ name: '@flighthq/node-tool', requiredEnvironment: 'node', selectedEnvironment: 'web' }],
      includedPackageNames: ['@flighthq/core', '@flighthq/web-app', '@flighthq/web-renderer'],
    });
    expect(
      createFlightPackageEligibilitySubsetPlan({ environment: 'node', candidatePackageNames, packages }),
    ).toMatchObject({
      environment: 'node',
      excludedRoots: [
        { name: '@flighthq/web-app', requiredEnvironment: 'web', selectedEnvironment: 'node' },
        { name: '@flighthq/web-renderer', requiredEnvironment: 'web', selectedEnvironment: 'node' },
      ],
      includedPackageNames: ['@flighthq/core', '@flighthq/node-tool'],
    });
  });

  it('returns deeply immutable data without mutating caller input', () => {
    const options: FlightPackageEligibilitySubsetOptions = {
      candidatePackageNames: ['@flighthq/core', '@flighthq/browser'],
      packages: [createPackage('@flighthq/core', []), createPackage('@flighthq/browser', [], 'web')],
    };
    const snapshot = structuredClone(options);

    const plan = createFlightPackageEligibilitySubsetPlan(options);

    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.excludedRoots)).toBe(true);
    expect(Object.isFrozen(plan.excludedRoots[0])).toBe(true);
    expect(Object.isFrozen(plan.excludedRoots[0]?.dependencyPath)).toBe(true);
    expect(Object.isFrozen(plan.includedPackageNames)).toBe(true);
    expect(options).toEqual(snapshot);
  });

  it('rejects malformed or unknown candidate roots through existing stable failure codes', () => {
    const core = createPackage('@flighthq/core', []);
    const cases: Array<{ code: FlightPackageEligibilityFailureCode; options: unknown }> = [
      { code: 'invalid-selection', options: null },
      { code: 'invalid-selection', options: { candidatePackageNames: null, packages: [] } },
      { code: 'invalid-selection', options: { candidatePackageNames: ['', ''], packages: [core] } },
      {
        code: 'invalid-selection',
        options: { candidatePackageNames: ['@flighthq/core', '@flighthq/core'], packages: [core] },
      },
      { code: 'unknown-package', options: { candidatePackageNames: ['@flighthq/missing'], packages: [core] } },
    ];

    for (const testCase of cases) {
      expect(captureFailure(() => createFlightPackageEligibilitySubsetPlan(testCase.options as never))).toMatchObject({
        code: testCase.code,
        kind: 'flight-package-eligibility',
      });
    }
  });
});

describe('isFlightPackageEligibilityFailure', () => {
  it('accepts exact failures and rejects ordinary and malformed lookalikes', () => {
    const failure = captureFailure(() =>
      createFlightPackageEligibilityPlan({
        packages: [createPackage('@flighthq/browser', [], 'web')],
        selectedPackageNames: ['@flighthq/browser'],
      }),
    );
    expect(isFlightPackageEligibilityFailure(failure)).toBe(true);
    for (const value of [
      undefined,
      new Error('ordinary'),
      Object.assign(new Error('lookalike'), { kind: 'flight-package-eligibility' }),
      Object.assign(new Error('lookalike'), {
        code: 'unknown',
        kind: 'flight-package-eligibility',
        subject: '@flighthq/browser',
      }),
      Object.assign(new Error('lookalike'), {
        code: 'ineligible-package-environment',
        dependencyPath: [],
        kind: 'flight-package-eligibility',
        requiredEnvironment: 'web',
        selectedEnvironment: null,
        subject: '@flighthq/browser',
      }),
    ]) {
      expect(isFlightPackageEligibilityFailure(value)).toBe(false);
    }
  });
});

function captureFailure(run: () => unknown): FlightPackageEligibilityFailure {
  let failure: unknown;
  try {
    run();
  } catch (error) {
    failure = error;
  }
  expect(isFlightPackageEligibilityFailure(failure)).toBe(true);
  return failure as FlightPackageEligibilityFailure;
}

function createPackage(
  name: string,
  dependencies: readonly string[],
  environment?: FlightPackageEnvironment,
): FlightPackageEligibilityPackage {
  return { dependencies, ...(environment === undefined ? {} : { environment }), name };
}
