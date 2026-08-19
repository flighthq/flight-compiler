import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { analyzeFlightWorkspace } from './index.js';

describe('inventory export graph regressions', () => {
  it('omits ambiguous star exports and reports every conflicting source', () => {
    const upstream = createFixture({
      'packages/types/src/a.ts': 'export function collide(): number { return 1; }',
      'packages/types/src/b.ts': 'export function collide(): number { return 2; }',
      'packages/types/src/index.ts': "export * from './a.js'; export * from './b.js';",
    });
    try {
      const inventory = analyzeFlightWorkspace({ upstreamDirectory: upstream });
      const root = inventory.packages.find((item) => item.name === '@flighthq/types')?.exportLanes[0];

      expect(root?.exports.map((item) => item.name)).not.toContain('collide');
      expect(root?.exportConflicts).toEqual([
        {
          name: 'collide',
          sources: ['packages/types/src/a.ts', 'packages/types/src/b.ts'],
        },
      ]);
    } finally {
      rmSync(upstream, { force: true, recursive: true });
    }
  });

  it('reaches a stable fixed point for cyclic barrels in every export lane', () => {
    const upstream = createFixture(
      {
        'packages/types/src/a.ts': "export * from './b.js'; export function fromA(): number { return 1; }",
        'packages/types/src/b.ts': "export * from './a.js'; export function fromB(): number { return 2; }",
        'packages/types/src/index.ts': "export * from './a.js';",
      },
      {
        '.': { default: './dist/index.js', types: './dist/index.d.ts' },
        './a': { default: './dist/a.js', types: './dist/a.d.ts' },
        './b': { default: './dist/b.js', types: './dist/b.d.ts' },
      },
    );
    try {
      const inventory = analyzeFlightWorkspace({ upstreamDirectory: upstream });
      const lanes = inventory.packages.find((item) => item.name === '@flighthq/types')?.exportLanes;

      expect(lanes?.map((lane) => lane.exports.map((item) => item.name))).toEqual([
        ['fromA', 'fromB'],
        ['fromA', 'fromB'],
        ['fromA', 'fromB'],
      ]);
    } finally {
      rmSync(upstream, { force: true, recursive: true });
    }
  });

  it('routes cross-package imports through declared export-map lanes', () => {
    const upstream = createFixture(
      {
        'packages/sdk/src/index.ts': "export * from '@flighthq/types/public';",
        'packages/types/src/actual.ts': 'export function publicValue(): number { return 1; }',
        'packages/types/src/index.ts': 'export {};',
      },
      {
        '.': { default: './dist/index.js', types: './dist/index.d.ts' },
        './public': { default: './dist/actual.js', types: './dist/actual.d.ts' },
      },
    );
    try {
      const inventory = analyzeFlightWorkspace({ upstreamDirectory: upstream });
      const sdk = inventory.packages.find((item) => item.name === '@flighthq/sdk');

      expect(sdk?.exportLanes[0]?.exports).toEqual([
        expect.objectContaining({ name: 'publicValue', source: 'packages/types/src/actual.ts' }),
      ]);
    } finally {
      rmSync(upstream, { force: true, recursive: true });
    }
  });
});

function createFixture(
  files: Readonly<Record<string, string>>,
  typeExports: Readonly<Record<string, { default: string; types: string }>> = {
    '.': { default: './dist/index.js', types: './dist/index.d.ts' },
  },
): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'flight-compiler-inventory-regression-'));
  write(
    directory,
    'tsconfig.json',
    JSON.stringify({
      compilerOptions: {
        module: 'ESNext',
        moduleResolution: 'Bundler',
        paths: {
          '@flighthq/types': ['./packages/types/src/index.ts'],
          '@flighthq/types/public': ['./packages/types/src/actual.ts'],
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
    JSON.stringify({ exports: typeExports, name: '@flighthq/types', version: '0.0.0' }),
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
  const defaults = {
    'packages/sdk/src/index.ts': "export * from '@flighthq/types';",
    'packages/types/src/index.ts': 'export {};',
  };
  for (const [file, contents] of Object.entries({ ...defaults, ...files })) write(directory, file, contents);
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
