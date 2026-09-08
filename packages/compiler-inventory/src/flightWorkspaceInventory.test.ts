import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { normalizePathPortable } from '../../compiler-canonical-form/src/index.js';
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
        exports: 15,
        hostDependencies: 0,
        hostImports: 0,
        packages: 2,
        productionImports: 6,
        rootExports: 10,
        sourceFiles: 7,
        testFiles: 1,
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
      // Mode's runtime value is a separate declaration from the exported type, so the binding is carried.
      // createValue is its own runtime declaration, so carrying a binding would only repeat the record:
      // the three-way agreement on fingerprint, kind and source is what decides between the two.
      // createPublicValue is renamed twice on the way out: once by the import clause and once by the
      // export clause, so the name reaches the lane through two aliases and matches the declaring
      // file at neither end. Renaming on both sides is what makes it a real test — an implementation
      // that ignored either clause could still answer correctly for a name that happened to match.
      expect(root.exports.find((item) => item.name === 'createPublicValue')).toMatchObject({
        kind: 'function',
        runtime: true,
        source: 'packages/types/src/other.ts',
      });
      expect(root.exports.find((item) => item.name === 'createDirectAlias')).toMatchObject({
        kind: 'function',
        runtime: true,
        source: 'packages/types/src/value.ts',
      });
      const createValueExport = root.exports.find((item) => item.name === 'createValue');
      expect(createValueExport).toMatchObject({ kind: 'function', runtime: true });
      expect(createValueExport?.runtimeBinding).toBeUndefined();
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

  it('resolves class, enum, namespace, default export, namespace import, and star masking', () => {
    const upstream = createUpstreamFixture();
    try {
      write(
        upstream,
        'packages/types/src/Kind.ts',
        'export class Kind { readonly value = 1; }\nexport enum Axis { X, Y }\nexport namespace Scope { export const depth = 1; }\n',
      );
      write(
        upstream,
        'packages/types/src/defaultExport.ts',
        "import * as ns from './Kind.js';\nexport default class DefaultKind { readonly axis = ns.Axis.X; }\n",
      );
      write(
        upstream,
        'packages/types/src/index.ts',
        "export { Mode } from './Mode.js';\nexport type { Shape } from './Shape.js';\nexport { createValue } from './value.js';\n" +
          "import { createOtherValue as createRenamedValue } from './other.js';\nexport { createRenamedValue as createPublicValue };\n" +
          "export { createValue as createDirectAlias } from './value.js';\n" +
          "export { Kind, Axis, Scope } from './Kind.js';\nexport { default as DefaultKind } from './defaultExport.js';\n" +
          "export * as KindNamespace from './Kind.js';\n",
      );
      git(upstream, 'add', '.');
      git(upstream, 'commit', '-m', 'kinds');

      const inventory = analyzeFlightWorkspace({ upstreamDirectory: upstream });
      const inventoryByName = new Map(inventory.packages.map((item) => [item.name, item]));
      const root = resolvePackageExportLane(inventoryByName, '@flighthq/types');
      const exportNames = root.exports.map((e) => e.name).sort();

      expect(exportNames).toContain('Kind');
      expect(exportNames).toContain('Axis');
      expect(exportNames).toContain('Scope');
      expect(exportNames).toContain('DefaultKind');
      expect(exportNames).toContain('KindNamespace');
      expect(root.exports.find((e) => e.name === 'Kind')).toMatchObject({ kind: 'class', runtime: true });
      expect(root.exports.find((e) => e.name === 'Axis')).toMatchObject({ kind: 'enum', runtime: true });
      expect(root.exports.find((e) => e.name === 'Scope')).toMatchObject({ kind: 'namespace', runtime: true });
      expect(root.exports.find((e) => e.name === 'DefaultKind')).toMatchObject({ kind: 'class', runtime: true });
      expect(root.exports.find((e) => e.name === 'KindNamespace')).toMatchObject({ kind: 'namespace' });
    } finally {
      rmSync(upstream, { force: true, recursive: true });
    }
  });

  it('resolves export conflicts and star export masking', () => {
    const upstream = createUpstreamFixture();
    try {
      write(upstream, 'packages/types/src/conflict-a.ts', 'export function conflicted(): string { return "a"; }\n');
      write(upstream, 'packages/types/src/conflict-b.ts', 'export function conflicted(): string { return "b"; }\n');
      write(
        upstream,
        'packages/types/src/index.ts',
        "export * from './conflict-a.js';\nexport * from './conflict-b.js';\nexport { createValue } from './value.js';\n" +
          "export type { Shape } from './Shape.js';\nexport { Mode } from './Mode.js';\n" +
          "import { createOtherValue as createRenamedValue } from './other.js';\nexport { createRenamedValue as createPublicValue };\n" +
          "export { createValue as createDirectAlias } from './value.js';\n",
      );
      git(upstream, 'add', '.');
      git(upstream, 'commit', '-m', 'conflicts');

      const inventory = analyzeFlightWorkspace({ upstreamDirectory: upstream });
      const inventoryByName = new Map(inventory.packages.map((item) => [item.name, item]));
      const root = resolvePackageExportLane(inventoryByName, '@flighthq/types');

      expect(root.exportConflicts.length).toBeGreaterThan(0);
      expect(root.exportConflicts[0]?.name).toBe('conflicted');
    } finally {
      rmSync(upstream, { force: true, recursive: true });
    }
  });

  it('resolves a .tsx source extension', () => {
    const upstream = createUpstreamFixture();
    try {
      write(
        upstream,
        'tsconfig.json',
        JSON.stringify({
          compilerOptions: {
            jsx: 'react',
            module: 'ESNext',
            moduleResolution: 'Bundler',
            paths: {
              '@flighthq/types': ['./packages/types/src/index.ts'],
              '@flighthq/types/*': ['./packages/types/src/*'],
            },
            strict: true,
            target: 'ES2022',
          },
          include: ['packages/**/*.ts', 'packages/**/*.tsx'],
        }),
      );
      write(upstream, 'packages/types/src/Component.tsx', 'export function Component(): number { return 1; }\n');
      write(
        upstream,
        'packages/types/src/index.ts',
        "export { Mode } from './Mode.js';\nexport type { Shape } from './Shape.js';\nexport { createValue } from './value.js';\n" +
          "export { Component } from './Component.js';\n" +
          "import { createOtherValue as createRenamedValue } from './other.js';\nexport { createRenamedValue as createPublicValue };\n" +
          "export { createValue as createDirectAlias } from './value.js';\n",
      );
      git(upstream, 'add', '.');
      git(upstream, 'commit', '-m', 'tsx');

      const inventory = analyzeFlightWorkspace({ upstreamDirectory: upstream });
      const inventoryByName = new Map(inventory.packages.map((item) => [item.name, item]));
      const root = resolvePackageExportLane(inventoryByName, '@flighthq/types');

      expect(root.exports.find((e) => e.name === 'Component')).toMatchObject({ kind: 'function', runtime: true });
    } finally {
      rmSync(upstream, { force: true, recursive: true });
    }
  });

  it('fails on an unresolvable package specifier in an export declaration', () => {
    const upstream = createUpstreamFixture();
    try {
      write(upstream, 'packages/types/src/index.ts', "export { value } from 'bare-specifier';\n");
      git(upstream, 'add', '.');
      git(upstream, 'commit', '-m', 'bad specifier');

      expectInventoryFailure(
        () => analyzeFlightWorkspace({ upstreamDirectory: upstream }),
        'unsupported-package-specifier',
      );
    } finally {
      rmSync(upstream, { force: true, recursive: true });
    }
  });

  it('fails on an unknown package in an export re-export', () => {
    const upstream = createUpstreamFixture();
    try {
      write(upstream, 'packages/types/src/index.ts', "export { value } from '@flighthq/nonexistent';\n");
      git(upstream, 'add', '.');
      git(upstream, 'commit', '-m', 'unknown package');

      expectInventoryFailure(() => analyzeFlightWorkspace({ upstreamDirectory: upstream }), 'unknown-package');
    } finally {
      rmSync(upstream, { force: true, recursive: true });
    }
  });

  it('fails on a module that cannot be resolved to a source file', () => {
    const upstream = createUpstreamFixture();
    try {
      write(upstream, 'packages/types/src/index.ts', "export { value } from './nonexistent.js';\n");
      git(upstream, 'add', '.');
      git(upstream, 'commit', '-m', 'missing source');

      expectInventoryFailure(() => analyzeFlightWorkspace({ upstreamDirectory: upstream }), 'unresolved-source');
    } finally {
      rmSync(upstream, { force: true, recursive: true });
    }
  });

  it('refuses a program file that resolves outside the upstream checkout', () => {
    const upstream = createUpstreamFixture();
    const outside = mkdtempSync(path.join(os.tmpdir(), 'flight-compiler-outside-'));
    try {
      writeFileSync(
        path.join(outside, 'escaped.ts'),
        'export function createEscaped(value: number): number { return value; }\n',
      );
      const specifier = normalizePathPortable(
        path.relative(path.join(upstream, 'packages', 'types', 'src'), path.join(outside, 'escaped.js')),
      );
      write(
        upstream,
        'packages/types/src/value.ts',
        `export function createValue(value: number): number { return value; }\nexport { createEscaped } from '${specifier}';\n`,
      );

      expectInventoryFailure(() => analyzeFlightWorkspace({ upstreamDirectory: upstream }), 'invalid-source-path');
    } finally {
      rmSync(outside, { force: true, recursive: true });
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
    "export { Mode } from './Mode.js';\nexport type { Shape } from './Shape.js';\nexport { createValue } from './value.js';\n" +
      "import { createOtherValue as createRenamedValue } from './other.js';\nexport { createRenamedValue as createPublicValue };\n" +
      "export { createValue as createDirectAlias } from './value.js';\n",
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
  // A declaration file and a colocated test sit beside the sources so the inventory has to exclude
  // both: a .d.ts would otherwise be analyzed as a second declaration of the same symbols, and a test
  // file would be read as public API.
  // other.ts is reachable only through the renamed local re-export in index.ts, so the module graph
  // has to follow the import alias to find it at all.
  write(
    directory,
    'packages/types/src/other.ts',
    'export function createOtherValue(value: number): number { return value; }\n',
  );
  write(directory, 'packages/types/src/ambient.d.ts', 'export declare const ambient: number;\n');
  write(directory, 'packages/types/src/value.test.ts', 'export const cases: number[] = [];\n');
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
