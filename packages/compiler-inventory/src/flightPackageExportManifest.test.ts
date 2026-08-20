import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { CompilerInventoryFailureCode } from '../../compiler-types/src/index.js';
import { isCompilerInventoryFailure } from './compilerInventoryFailure.js';
import { readPackageExportManifest } from './flightPackageExportManifest.js';
import { createHostWorkspaceSource } from './hostWorkspaceSource.js';

describe('readPackageExportManifest', () => {
  it('resolves every condition and lane to deterministic source-barrel identities', () => {
    const upstream = createFixture({
      '.': { default: './dist/index.js', types: './dist/index.d.ts' },
      './contract': {
        browser: './dist/contract.js',
        default: './dist/contract.js',
        types: './dist/contract.d.ts',
      },
    });
    try {
      expect(
        readPackageExportManifest(path.join(upstream, 'packages', 'types'), createHostWorkspaceSource(), upstream),
      ).toEqual([
        {
          conditions: [
            { condition: 'default', source: 'packages/types/src/index.ts', target: './dist/index.js' },
            { condition: 'types', source: 'packages/types/src/index.ts', target: './dist/index.d.ts' },
          ],
          entry: '.',
          source: 'packages/types/src/index.ts',
          specifier: '@flighthq/types',
        },
        {
          conditions: [
            { condition: 'browser', source: 'packages/types/src/contract.ts', target: './dist/contract.js' },
            { condition: 'default', source: 'packages/types/src/contract.ts', target: './dist/contract.js' },
            { condition: 'types', source: 'packages/types/src/contract.ts', target: './dist/contract.d.ts' },
          ],
          entry: './contract',
          source: 'packages/types/src/contract.ts',
          specifier: '@flighthq/types/contract',
        },
      ]);
    } finally {
      rmSync(upstream, { force: true, recursive: true });
    }
  });

  it('rejects malformed manifests, export lanes, conditions, and targets with stable identities', () => {
    const cases: ReadonlyArray<readonly [unknown, CompilerInventoryFailureCode]> = [
      [[], 'invalid-package-export'],
      [{ './contract': { default: './dist/contract.js', types: './dist/contract.d.ts' } }, 'missing-package-export'],
      [{ '.': null }, 'invalid-package-export'],
      [{ '.': { default: './dist/index.js' } }, 'invalid-package-export'],
      [{ '.': { browser: 1, default: './dist/index.js', types: './dist/index.d.ts' } }, 'invalid-package-export'],
      [{ '.': { default: '../index.js', types: './dist/index.d.ts' } }, 'invalid-package-export'],
      [{ private: { default: './dist/index.js', types: './dist/index.d.ts' } }, 'invalid-package-export'],
    ];
    for (const [exports, code] of cases) {
      const upstream = createFixture(exports);
      try {
        expectInventoryFailure(
          () =>
            readPackageExportManifest(path.join(upstream, 'packages', 'types'), createHostWorkspaceSource(), upstream),
          code,
        );
      } finally {
        rmSync(upstream, { force: true, recursive: true });
      }
    }
  });

  it('rejects invalid JSON, missing source barrels, and package paths outside the checkout', () => {
    const upstream = createFixture({ '.': { default: './dist/missing.js', types: './dist/missing.d.ts' } });
    const external = createFixture({ '.': { default: './dist/index.js', types: './dist/index.d.ts' } });
    const packageDirectory = path.join(upstream, 'packages', 'types');
    try {
      expectInventoryFailure(
        () => readPackageExportManifest(packageDirectory, createHostWorkspaceSource(), upstream),
        'unresolved-source',
      );
      expectInventoryFailure(
        () =>
          readPackageExportManifest(path.join(external, 'packages', 'types'), createHostWorkspaceSource(), upstream),
        'invalid-source-path',
      );
      writeFileSync(path.join(packageDirectory, 'package.json'), '{');
      expectInventoryFailure(
        () => readPackageExportManifest(packageDirectory, createHostWorkspaceSource(), upstream),
        'invalid-package-manifest',
      );
      writeFileSync(path.join(packageDirectory, 'package.json'), '[]');
      expectInventoryFailure(
        () => readPackageExportManifest(packageDirectory, createHostWorkspaceSource(), upstream),
        'invalid-package-manifest',
      );
      writeFileSync(
        path.join(packageDirectory, 'package.json'),
        JSON.stringify({ exports: {}, name: '@flighthq/types' }),
      );
      expectInventoryFailure(
        () => readPackageExportManifest(packageDirectory, createHostWorkspaceSource(), upstream),
        'invalid-package-manifest',
      );
    } finally {
      rmSync(upstream, { force: true, recursive: true });
      rmSync(external, { force: true, recursive: true });
    }
  });
});

function createFixture(exports: unknown): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'flight-compiler-export-manifest-'));
  const packageDirectory = path.join(directory, 'packages', 'types');
  mkdirSync(path.join(packageDirectory, 'src'), { recursive: true });
  writeFileSync(
    path.join(packageDirectory, 'package.json'),
    JSON.stringify({ exports, name: '@flighthq/types', version: '0.0.0' }),
  );
  writeFileSync(path.join(packageDirectory, 'src', 'index.ts'), 'export {};');
  writeFileSync(path.join(packageDirectory, 'src', 'contract.ts'), 'export {};');
  return directory;
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
