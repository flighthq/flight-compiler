import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  analyzeFlightWorkspace,
  packageRootExportLane,
  readPackageExportManifest,
  resolvePackageExportLane,
} from './index.js';

describe('Flight workspace inventory', () => {
  it('resolves export lanes, runtime bindings, SDK exposure, and portable provenance', () => {
    const upstream = createUpstreamFixture();
    try {
      const inventory = analyzeFlightWorkspace({ upstreamDirectory: upstream });
      const inventoryByName = new Map(inventory.packages.map((item) => [item.name, item]));
      const types = inventoryByName.get('@flighthq/types');
      if (!types) throw new Error('Expected fixture types package');
      const root = resolvePackageExportLane(inventoryByName, '@flighthq/types');
      const contract = resolvePackageExportLane(inventoryByName, '@flighthq/types/contract');

      expect(inventory.schema).toBe('flight-compiler-inventory/1');
      expect(inventory.upstreamCommit).toMatch(/^[0-9a-f]{40}$/u);
      expect(inventory.summary).toEqual({
        exportConflicts: 0,
        exportLanes: 3,
        exports: 9,
        packages: 2,
        rootExports: 6,
        sourceFiles: 6,
        testFiles: 0,
      });
      expect(packageRootExportLane(types)).toBe(root);
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
      expect(() => resolvePackageExportLane(inventoryByName, '@flighthq/types/private')).toThrow(
        'Package import uses an unaccounted export lane: @flighthq/types/private',
      );
    } finally {
      rmSync(upstream, { force: true, recursive: true });
    }
  });

  it('fails when a manifest lane cannot be traced to a source barrel', () => {
    const upstream = createUpstreamFixture();
    try {
      const packageDirectory = path.join(upstream, 'packages', 'types');
      write(
        packageDirectory,
        'package.json',
        JSON.stringify({
          exports: {
            '.': { default: './dist/index.js', types: './dist/index.d.ts' },
            './missing': { default: './dist/missing.js', types: './dist/missing.d.ts' },
          },
          name: '@flighthq/types',
          version: '0.0.0',
        }),
      );
      expect(() => readPackageExportManifest(packageDirectory, upstream)).toThrow(
        'Package export condition @flighthq/types/missing [default] has no source barrel',
      );
    } finally {
      rmSync(upstream, { force: true, recursive: true });
    }
  });
});

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
