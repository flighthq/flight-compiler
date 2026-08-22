import type { UpstreamInventory } from '../../compiler-types/src/index.js';
import { createCompilerModuleResolutionPlan, isCompilerModuleResolutionFailure } from './compilerModuleResolution.js';

describe('createCompilerModuleResolutionPlan', () => {
  it('creates deterministic immutable package-export edges with portable source identity', () => {
    const inventory = createInventory([
      createPackage('@flighthq/types', [
        { source: 'packages\\types\\src\\public.ts', specifier: '@flighthq/types/public' },
        { source: 'packages/types/src/index.ts', specifier: '@flighthq/types' },
      ]),
      createPackage('@flighthq/core', [{ source: 'packages/core/src/index.ts', specifier: '@flighthq/core' }]),
    ]);
    const snapshot = structuredClone(inventory);

    const plan = createCompilerModuleResolutionPlan(inventory);

    expect(plan).toEqual({
      edges: [
        {
          specifier: '@flighthq/core',
          target: { packageName: '@flighthq/core', source: 'packages/core/src/index.ts' },
        },
        {
          specifier: '@flighthq/types',
          target: { packageName: '@flighthq/types', source: 'packages/types/src/index.ts' },
        },
        {
          specifier: '@flighthq/types/public',
          target: { packageName: '@flighthq/types', source: 'packages/types/src/public.ts' },
        },
      ],
      schema: 'flight-compiler-module-resolution/1',
    });
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.edges)).toBe(true);
    expect(plan.edges.every(Object.isFrozen)).toBe(true);
    expect(plan.edges.every((edge) => Object.isFrozen(edge.target))).toBe(true);
    expect(inventory).toEqual(snapshot);
    expect(createCompilerModuleResolutionPlan(createInventory([...inventory.packages].reverse()))).toEqual(plan);
  });

  it('rejects malformed inventory, lanes, paths, and duplicate public specifiers through stable codes', () => {
    const failures: unknown[] = [];
    const invalid = [
      null,
      { packages: [], schema: 'invalid' },
      { packages: null, schema: 'flight-compiler-inventory/2' },
      createInventory([null as never]),
      createInventory([{ ...createPackage('@flighthq/types', []), name: '' }]),
      createInventory([{ ...createPackage('@flighthq/types', []), exportLanes: null } as never]),
      createInventory([createPackage('@flighthq/types', [null as never])]),
      createInventory([createPackage('@flighthq/types', [{ source: 'index.ts', specifier: '' }])]),
      createInventory([createPackage('@flighthq/types', [{ source: 1 as never, specifier: '@flighthq/types' }])]),
      createInventory([createPackage('@flighthq/types', [{ source: 'index.ts', specifier: '@flighthq/other' }])]),
      createInventory([createPackage('@flighthq/types', [{ source: '/index.ts', specifier: '@flighthq/types' }])]),
      createInventory([createPackage('@flighthq/types', [{ source: 'C:/index.ts', specifier: '@flighthq/types' }])]),
      createInventory([
        createPackage('@flighthq/types', [{ source: 'src/../index.ts', specifier: '@flighthq/types' }]),
      ]),
      createInventory([createPackage('@flighthq/types', [{ source: 'src//index.ts', specifier: '@flighthq/types' }])]),
      createInventory([
        createPackage('@flighthq/types', [
          { source: 'src/index.ts', specifier: '@flighthq/types' },
          { source: 'src/other.ts', specifier: '@flighthq/types' },
        ]),
      ]),
    ];
    for (const inventory of invalid) {
      try {
        createCompilerModuleResolutionPlan(inventory as never);
      } catch (error) {
        failures.push(error);
      }
    }

    expect(failures).toHaveLength(invalid.length);
    expect(failures.every(isCompilerModuleResolutionFailure)).toBe(true);
    expect(new Set(failures.map((failure) => (failure as { code: string }).code))).toEqual(
      new Set(['duplicate-package-specifier', 'invalid-inventory', 'invalid-package-export-lane']),
    );
  });
});

describe('isCompilerModuleResolutionFailure', () => {
  it('accepts exact failures and rejects ordinary or malformed lookalikes', () => {
    let failure: unknown;
    try {
      createCompilerModuleResolutionPlan(null as never);
    } catch (error) {
      failure = error;
    }
    expect(isCompilerModuleResolutionFailure(failure)).toBe(true);
    for (const value of [
      undefined,
      new Error('ordinary'),
      Object.assign(new Error('lookalike'), { kind: 'compiler-module-resolution' }),
      Object.assign(new Error('lookalike'), {
        code: 'unknown',
        kind: 'compiler-module-resolution',
        subject: 'inventory',
      }),
      Object.assign(new Error('lookalike'), {
        code: 'invalid-inventory',
        kind: 'compiler-module-resolution',
      }),
      Object.assign(new Error('lookalike'), {
        code: 'invalid-inventory',
        kind: 'compiler-module-resolution',
        subject: 1,
      }),
      Object.assign(new Error('lookalike'), {
        code: 'invalid-inventory',
        kind: 'compiler-module-resolution',
        subject: '',
      }),
    ]) {
      expect(isCompilerModuleResolutionFailure(value)).toBe(false);
    }
  });
});

function createInventory(packages: unknown[]): UpstreamInventory {
  return { packages, schema: 'flight-compiler-inventory/2' } as unknown as UpstreamInventory;
}

function createPackage(name: string, lanes: Array<{ source: string; specifier: string }>) {
  return {
    exportLanes: lanes,
    name,
  };
}
