import type { FlightWorkspaceCompilationInput } from '../../compiler-types/src/index.js';
import {
  createFlightWorkspaceCompilationInput,
  isFlightWorkspaceCompilationFailure,
} from './flightWorkspaceCompilationInput.js';
import { createMemoryWorkspaceSource } from './memoryWorkspaceSource.js';

describe('createFlightWorkspaceCompilationInput', () => {
  it('builds deterministic package, source, export, and import identities without mutating the workspace', () => {
    const files = createWorkspaceFiles();
    const reversedFiles = Object.fromEntries(Object.entries(files).reverse());
    const snapshot = structuredClone(files);

    const first = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/app', '@flighthq/base'],
      source: createMemoryWorkspaceSource(files),
      upstreamDirectory: '/flight',
    });
    const second = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/base', '@flighthq/app'],
      source: createMemoryWorkspaceSource(reversedFiles),
      upstreamDirectory: '/flight',
    });

    expect(summarizeInput(first)).toEqual(summarizeInput(second));
    expect(first.graph.packages).toEqual([
      {
        dependencies: ['@flighthq/base'],
        name: '@flighthq/app',
        root: '/flight/packages/app',
      },
      { dependencies: [], name: '@flighthq/base', root: '/flight/packages/base' },
    ]);
    expect(first.graph.entries).toEqual([
      { name: 'Index', packageName: '@flighthq/app', source: 'packages/app/src/index.ts' },
      { name: 'Index', packageName: '@flighthq/base', source: 'packages/base/src/index.ts' },
    ]);
    expect(
      first.graph.moduleDependencies.map((dependency) => [
        dependency.importer.source,
        dependency.specifier,
        dependency.target.source,
      ]),
    ).toEqual([
      ['packages/app/src/consumer.ts', './helper.js', 'packages/app/src/helper.ts'],
      ['packages/app/src/consumer.ts', '@flighthq/base', 'packages/base/src/index.ts'],
      ['packages/app/src/index.ts', './consumer.js', 'packages/app/src/consumer.ts'],
      ['packages/base/src/index.ts', './broken.js', 'packages/base/src/broken.ts'],
      ['packages/base/src/index.ts', './stable.js', 'packages/base/src/stable.ts'],
    ]);
    expect(first.sources.map((source) => source.sourceFile.fileName)).toEqual([
      '/flight/packages/app/src/consumer.ts',
      '/flight/packages/app/src/helper.ts',
      '/flight/packages/app/src/index.ts',
      '/flight/packages/base/src/broken.ts',
      '/flight/packages/base/src/index.ts',
      '/flight/packages/base/src/stable.ts',
    ]);
    expect(first.moduleResolution.edges).toContainEqual({
      specifier: '@flighthq/base',
      target: { packageName: '@flighthq/base', source: 'packages/base/src/index.ts' },
    });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.graph.moduleDependencies)).toBe(true);
    expect(files).toEqual(snapshot);
  });

  it('rejects empty, duplicate, unknown, and dependency-incomplete eligible package selections', () => {
    const source = createMemoryWorkspaceSource(createWorkspaceFiles());
    const attempts = [
      { eligiblePackageNames: [] },
      { eligiblePackageNames: ['@flighthq/base', '@flighthq/base'] },
      { eligiblePackageNames: ['@flighthq/missing'] },
      { eligiblePackageNames: ['@flighthq/app'] },
    ];

    const failures = attempts.map(({ eligiblePackageNames }) => {
      try {
        createFlightWorkspaceCompilationInput({ eligiblePackageNames, source, upstreamDirectory: '/flight' });
        throw new Error('expected workspace compilation input failure');
      } catch (error) {
        return error;
      }
    });

    expect(failures.every(isFlightWorkspaceCompilationFailure)).toBe(true);
    expect(failures.map((failure) => (failure as { code: string }).code)).toEqual([
      'empty-eligible-package-set',
      'duplicate-eligible-package',
      'unknown-eligible-package',
      'incomplete-package-closure',
    ]);
  });

  it('fails loudly with source and specifier identity when an import cannot be resolved', () => {
    const files = createWorkspaceFiles({
      '/flight/packages/app/src/consumer.ts':
        "import { broken } from '@flighthq/base'; import { missing } from './missing.js'; export const result = broken + missing;",
    });

    expect(() =>
      createFlightWorkspaceCompilationInput({
        eligiblePackageNames: ['@flighthq/app', '@flighthq/base'],
        source: createMemoryWorkspaceSource(files),
        upstreamDirectory: '/flight',
      }),
    ).toThrow(
      expect.objectContaining({
        code: 'unresolved-import',
        kind: 'flight-workspace-compilation',
        subject: 'packages/app/src/consumer.ts:./missing.js',
      }),
    );
  });

  it('builds the production graph from export reachability without compiling hoisted test helpers', () => {
    const files = createWorkspaceFiles({
      '/flight/node_modules/vitest/index.d.ts': 'export declare function expect(value: unknown): void;',
      '/flight/node_modules/vitest/package.json': JSON.stringify({
        name: 'vitest',
        types: './index.d.ts',
        version: '1.0.0',
      }),
      '/flight/package.json': JSON.stringify({ devDependencies: { vitest: '1.0.0' }, private: true }),
      '/flight/packages/app/src/glTestHelper.ts':
        "import { expect } from 'vitest'; export function expectReady(value: unknown): void { expect(value); void import(String(value)); }",
    });

    const input = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/app', '@flighthq/base'],
      source: createMemoryWorkspaceSource(files),
      upstreamDirectory: '/flight',
    });

    expect(input.sources.map((source) => source.sourceFile.fileName)).not.toContain(
      '/flight/packages/app/src/glTestHelper.ts',
    );
    expect(input.sources.every((source) => !source.sourceFile.fileName.includes('/node_modules/'))).toBe(true);
    expect(input.graph.moduleDependencies.every((dependency) => dependency.specifier !== 'vitest')).toBe(true);
  });

  it('keeps a reachable hoisted external import outside the Flight module graph', () => {
    const files = createWorkspaceFiles({
      '/flight/node_modules/vitest/index.d.ts': 'export declare function expect(value: unknown): void;',
      '/flight/node_modules/vitest/package.json': JSON.stringify({
        name: 'vitest',
        types: './index.d.ts',
        version: '1.0.0',
      }),
      '/flight/package.json': JSON.stringify({ devDependencies: { vitest: '1.0.0' }, private: true }),
      '/flight/packages/app/src/glTestHelper.ts':
        "import { expect } from 'vitest'; export function expectReady(value: unknown): void { expect(value); }",
      '/flight/packages/app/src/index.ts': "export { expectReady } from './glTestHelper.js';",
    });

    const input = createFlightWorkspaceCompilationInput({
      eligiblePackageNames: ['@flighthq/app', '@flighthq/base'],
      source: createMemoryWorkspaceSource(files),
      upstreamDirectory: '/flight',
    });

    expect(input.sources.map((source) => source.sourceFile.fileName)).toContain(
      '/flight/packages/app/src/glTestHelper.ts',
    );
    expect(input.sources.every((source) => !source.sourceFile.fileName.includes('/node_modules/'))).toBe(true);
    expect(input.graph.moduleDependencies).toContainEqual(
      expect.objectContaining({
        importer: expect.objectContaining({ source: 'packages/app/src/index.ts' }),
        specifier: './glTestHelper.js',
        target: expect.objectContaining({ source: 'packages/app/src/glTestHelper.ts' }),
      }),
    );
    expect(input.graph.moduleDependencies.every((dependency) => dependency.specifier !== 'vitest')).toBe(true);
    expect(input.moduleResolution.edges.every((edge) => edge.specifier !== 'vitest')).toBe(true);
  });
});

describe('isFlightWorkspaceCompilationFailure', () => {
  it('accepts exact adapter failures and rejects ordinary or malformed lookalikes', () => {
    let failure: unknown;
    try {
      createFlightWorkspaceCompilationInput({
        eligiblePackageNames: [],
        source: createMemoryWorkspaceSource(createWorkspaceFiles()),
        upstreamDirectory: '/flight',
      });
    } catch (error) {
      failure = error;
    }

    expect(isFlightWorkspaceCompilationFailure(failure)).toBe(true);
    for (const value of [
      undefined,
      new Error('ordinary'),
      Object.assign(new Error('lookalike'), { kind: 'flight-workspace-compilation' }),
      Object.assign(new Error('lookalike'), {
        code: 'unknown',
        kind: 'flight-workspace-compilation',
        subject: 'workspace',
      }),
      {
        code: 'unresolved-import',
        kind: 'flight-workspace-compilation',
        subject: 'workspace',
      },
    ]) {
      expect(isFlightWorkspaceCompilationFailure(value)).toBe(false);
    }
  });
});

function createPackageManifest(name: string, dependencies: Readonly<Record<string, string>> = {}): string {
  return JSON.stringify({
    dependencies,
    exports: {
      '.': { default: './dist/index.js', types: './dist/index.d.ts' },
    },
    name,
    version: '1.0.0',
  });
}

function createWorkspaceFiles(overrides: Readonly<Record<string, string>> = {}): Record<string, string> {
  return {
    '/flight/packages/app/package.json': createPackageManifest('@flighthq/app', { '@flighthq/base': '*' }),
    '/flight/packages/app/src/consumer.ts':
      "import { broken } from '@flighthq/base'; import { helper } from './helper.js'; export const result = broken + helper;",
    '/flight/packages/app/src/helper.test.ts': 'throw new Error("not production");',
    '/flight/packages/app/src/helper.ts': 'export const helper = 3;',
    '/flight/packages/app/src/index.ts': "export { result } from './consumer.js';",
    '/flight/packages/base/package.json': createPackageManifest('@flighthq/base'),
    '/flight/packages/base/src/broken.ts': 'export const broken = 2;',
    '/flight/packages/base/src/index.ts': "export { broken } from './broken.js'; export { stable } from './stable.js';",
    '/flight/packages/base/src/public.d.ts': 'export declare const ignored: number;',
    '/flight/packages/base/src/stable.ts': 'export const stable = 1;',
    ...overrides,
  };
}

function summarizeInput(input: Readonly<FlightWorkspaceCompilationInput>) {
  return {
    graph: input.graph,
    moduleResolution: input.moduleResolution,
    sources: input.sources.map((source) => ({
      packageName: source.packageName,
      packageRoot: source.packageRoot,
      sourceFile: { fileName: source.sourceFile.fileName, text: source.sourceFile.text },
      upstreamDirectory: source.upstreamDirectory,
    })),
  };
}
