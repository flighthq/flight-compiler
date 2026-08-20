import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { CompilerInventoryFailureCode } from '../../compiler-types/src/index.js';
import { isCompilerInventoryFailure } from './compilerInventoryFailure.js';
import { getPackageInventoryRootExportLane, resolvePackageExportLane } from './flightPackageExportLane.js';
import { analyzeFlightWorkspace } from './flightWorkspaceInventory.js';

describe('analyzeFlightWorkspace', () => {
  it('resolves export lanes, runtime bindings, SDK exposure, and portable provenance', () => {
    const upstream = createUpstreamFixture();
    try {
      const inventory = analyzeFlightWorkspace({ upstreamDirectory: upstream });
      const inventoryByName = new Map(inventory.packages.map((item) => [item.name, item]));
      const types = inventoryByName.get('@flighthq/types');
      if (!types) throw new Error('Expected fixture types package');
      const root = resolvePackageExportLane(inventoryByName, '@flighthq/types');
      const contract = resolvePackageExportLane(inventoryByName, '@flighthq/types/contract');

      expect(inventory.schema).toBe('flight-compiler-inventory/2');
      expect(inventory.upstreamCommit).toMatch(/^[0-9a-f]{40}$/u);
      expect(inventory.summary).toEqual({
        exportConflicts: 0,
        exportLanes: 3,
        excludedPackages: 0,
        exports: 9,
        hostDependencies: 0,
        hostImports: 0,
        packages: 2,
        productionImports: 5,
        rootExports: 6,
        sourceFiles: 6,
        testFiles: 0,
      });
      expect(getPackageInventoryRootExportLane(types)).toBe(root);
      expect(contract.exports).toEqual(root.exports);
      expect(root.exports.find((item) => item.name === 'Shape')).toMatchObject({
        kind: 'interface',
        runtime: false,
        source: 'packages/types/src/Shape.ts',
      });
      expect(root.exports.find((item) => item.name === 'Mode')).toMatchObject({
        kind: 'type',
        runtime: true,
        runtimeBinding: {
          kind: 'variable',
          source: 'packages/types/src/Mode.ts',
        },
      });
      expect(types.sdkExposures).toEqual([{ sdkLane: '@flighthq/sdk', target: '@flighthq/types' }]);
      expect(types.sdkIncluded).toBe(true);
      expectInventoryFailure(
        () => resolvePackageExportLane(inventoryByName, '@flighthq/types/private'),
        'missing-package-export',
      );
    } finally {
      rmSync(upstream, { force: true, recursive: true });
    }
  });

  it('reports the absent SDK package with a stable failure identity', () => {
    const upstream = createUpstreamFixture();
    try {
      write(
        upstream,
        'packages/sdk/package.json',
        JSON.stringify({
          exports: { '.': { default: './dist/index.js', types: './dist/index.d.ts' } },
          name: '@flighthq/not-sdk',
          version: '0.0.0',
        }),
      );

      expectInventoryFailure(() => analyzeFlightWorkspace({ upstreamDirectory: upstream }), 'missing-sdk-package');
    } finally {
      rmSync(upstream, { force: true, recursive: true });
    }
  });
});

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

function createUpstreamFixture(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'flight-compiler-inventory-'));
  write(
    directory,
    'tsconfig.json',
    JSON.stringify({
      compilerOptions: {
        module: 'ESNext',
        moduleResolution: 'Bundler',
        paths: {
          '@flighthq/types': ['./packages/types/src/index.ts'],
          '@flighthq/types/*': ['./packages/types/src/*'],
        },
        strict: true,
        target: 'ES2022',
      },
      include: ['packages/**/*.ts'],
    }),
  );
  write(
    directory,
    'packages/types/package.json',
    JSON.stringify({
      exports: {
        '.': { default: './dist/index.js', types: './dist/index.d.ts' },
        './contract': { default: './dist/contract.js', types: './dist/contract.d.ts' },
      },
      name: '@flighthq/types',
      version: '0.0.0',
    }),
  );
  write(
    directory,
    'packages/types/src/index.ts',
    "export { Mode } from './Mode.js';\nexport type { Shape } from './Shape.js';\nexport { createValue } from './value.js';\n",
  );
  write(directory, 'packages/types/src/contract.ts', "export * from './index.js';\n");
  write(
    directory,
    'packages/types/src/Mode.ts',
    "export const Mode = { fast: 'fast', safe: 'safe' } as const;\nexport type Mode = (typeof Mode)[keyof typeof Mode];\n",
  );
  write(directory, 'packages/types/src/Shape.ts', 'export interface Shape { readonly size: number; }\n');
  write(
    directory,
    'packages/types/src/value.ts',
    'export function createValue(value: number): number { return value; }\n',
  );
  write(
    directory,
    'packages/sdk/package.json',
    JSON.stringify({
      exports: { '.': { default: './dist/index.js', types: './dist/index.d.ts' } },
      name: '@flighthq/sdk',
      version: '0.0.0',
    }),
  );
  write(directory, 'packages/sdk/src/index.ts', "export * from '@flighthq/types';\n");
  git(directory, 'init');
  git(directory, 'config', 'user.email', 'compiler@example.invalid');
  git(directory, 'config', 'user.name', 'Compiler Fixture');
  git(directory, 'add', '.');
  git(directory, 'commit', '-m', 'fixture');
  return directory;
}

function git(directory: string, ...arguments_: string[]): void {
  execFileSync('git', ['-C', directory, ...arguments_], { stdio: 'ignore' });
}

function write(directory: string, file: string, contents: string): void {
  const target = path.join(directory, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents);
}
