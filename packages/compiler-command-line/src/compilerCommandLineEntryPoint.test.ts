import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  validateCompilerCommandLineCheckDirectory,
  compileCompilerCommandLineDirectory,
  isCompilerCommandLineEntryPoint,
} from './compilerCommandLineEntryPoint.js';

const workspaces: string[] = [];

function git(directory: string, ...arguments_: string[]): void {
  execFileSync('git', ['-C', directory, ...arguments_], { stdio: 'ignore' });
}

afterEach(() => {
  for (const workspace of workspaces.splice(0)) rmSync(workspace, { force: true, recursive: true });
});

describe('compileCompilerCommandLineDirectory', () => {
  it('reads a directory of TypeScript and writes what each module emitted', () => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'flight-command-line-'));
    workspaces.push(workspace);
    const source = path.join(workspace, 'src');
    mkdirSync(path.join(source, 'nested'), { recursive: true });
    writeFileSync(path.join(source, 'add.ts'), 'export function add(value: number): number { return value + 1; }');
    // A nested module is found, and a declaration file and a test are not compiled.
    writeFileSync(
      path.join(source, 'nested', 'twice.ts'),
      'export function twice(value: number): number { return value * 2; }',
    );
    writeFileSync(path.join(source, 'kinds.d.ts'), 'export declare function ignored(): void;');
    writeFileSync(path.join(source, 'add.test.ts'), 'export const ignored = 1;');

    const exitCode = compileCompilerCommandLineDirectory([
      source,
      '--target',
      'rust',
      '--out',
      path.join(workspace, 'out'),
    ]);

    expect(exitCode).toBe(0);
    expect(readdirSync(path.join(workspace, 'out'), { recursive: true }).map(String).sort()).toEqual([
      'add.rs',
      'twice.rs',
    ]);
    expect(readFileSync(path.join(workspace, 'out', 'add.rs'), 'utf8')).toContain('pub fn add(value: f64) -> f64 {');
  });

  it('reports a directory it cannot read as a failed run rather than an empty success', () => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'flight-command-line-'));
    workspaces.push(workspace);

    expect(
      compileCompilerCommandLineDirectory([path.join(workspace, 'src'), '--target', 'haxe', '--out', workspace]),
    ).toBe(2);
  });

  it('writes semantic C++ output with a caller-selected runtime include', () => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'flight-command-line-'));
    workspaces.push(workspace);
    const source = path.join(workspace, 'src');
    mkdirSync(source);
    writeFileSync(path.join(source, 'label.ts'), 'export function label(): string { return "flight"; }');
    const output = path.join(workspace, 'out');

    expect(
      compileCompilerCommandLineDirectory([
        source,
        '--target',
        'cpp',
        '--out',
        output,
        '--runtime-header',
        'vendor/flight.hpp',
      ]),
    ).toBe(0);

    const emitted = readFileSync(path.join(output, 'label.hpp'), 'utf8');
    expect(emitted).toContain('#include "vendor/flight.hpp"');
    expect(emitted).toContain('flight::String label()');
  });
});

describe('isCompilerCommandLineEntryPoint', () => {
  // The installed bin is a symlink into the package, so a guard that compares the two paths literally answers
  // no for every real invocation and the whole CLI becomes a silent exit 0. That is what this pins.
  it('recognizes the module when the machine ran it through a symlink', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'flight-command-line-entry-'));
    workspaces.push(directory);
    const moduleFile = path.join(directory, 'entry.js');
    const link = path.join(directory, 'flight-compile');
    writeFileSync(moduleFile, '#!/usr/bin/env node\n');
    symlinkSync(moduleFile, link);

    expect(isCompilerCommandLineEntryPoint(moduleFile, moduleFile)).toBe(true);
    expect(isCompilerCommandLineEntryPoint(link, moduleFile)).toBe(true);
    expect(isCompilerCommandLineEntryPoint(path.join(directory, 'other.js'), moduleFile)).toBe(false);
    expect(isCompilerCommandLineEntryPoint(undefined, moduleFile)).toBe(false);
  });
});

describe('validateCompilerCommandLineCheckDirectory', () => {
  // The check reads a workspace the way every other lane does, so the fixture is a real one: a package
  // with the root export lane its manifest declares and sources behind it. Nothing here is a shorthand
  // the compiler would not accept from a consumer.
  const createWorkspace = (sources: Readonly<Record<string, string>>): string => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'flight-command-line-check-'));
    workspaces.push(workspace);
    const root = path.join(workspace, 'packages', 'core');
    mkdirSync(path.join(root, 'src'), { recursive: true });
    writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({
        name: '@flighthq/core',
        version: '1.0.0',
        exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
      }),
    );
    for (const [moduleName, contents] of Object.entries(sources)) {
      const source = path.join(root, 'src', moduleName);
      mkdirSync(path.dirname(source), { recursive: true });
      writeFileSync(source, contents);
    }
    return workspace;
  };

  // A check run reads the workspace and leaves it alone. The generated-source capability is not part of
  // the check's record at all, so the strongest statement the test can make is the tree it started with.
  it('checks a workspace without writing a generated source beside it', () => {
    const workspace = createWorkspace({
      'bad.ts': 'export const ready = Promise.resolve(1);\nawait ready;\n',
      'index.ts': "export * from './bad.js';\n",
    });
    const before = readdirSync(workspace, { recursive: true }).map(String).sort();

    const exitCode = validateCompilerCommandLineCheckDirectory([workspace, '--target', 'rust']);

    expect(exitCode).toBe(1);
    expect(readdirSync(workspace, { recursive: true }).map(String).sort()).toEqual(before);
  });

  it('admits a workspace whose modules all compile', () => {
    const workspace = createWorkspace({
      'index.ts': 'export function doubled(value: number): number { return value * 2; }',
    });

    expect(validateCompilerCommandLineCheckDirectory([workspace, '--target', 'cpp'])).toBe(0);
  });

  it('writes the report it was asked for and nothing else', () => {
    const workspace = createWorkspace({
      'bad.ts': 'export const ready = Promise.resolve(1);\nawait ready;\n',
      'index.ts': "export * from './bad.js';\n",
    });
    const report = path.join(workspace, 'check-report.json');

    const exitCode = validateCompilerCommandLineCheckDirectory([
      workspace,
      '--target',
      'rust',
      '--format',
      'json',
      '--report',
      report,
    ]);

    expect(exitCode).toBe(1);
    expect(readFileSync(report, 'utf8')).toContain('"schema": "flight-compiler-check-run/1"');
    expect(
      readdirSync(path.join(workspace, 'packages', 'core', 'src'))
        .map(String)
        .sort(),
    ).toEqual(['bad.ts', 'index.ts']);
  });

  it('reports through unreachable hoisted test tooling and a non-runtime type cycle', () => {
    const workspace = createWorkspace({
      'bad.ts': 'export interface Bad { ready: boolean }\nexport const ready = Promise.resolve(1);\nawait ready;\n',
      'index.ts': "export { doubled } from './internal/doubled.js';\nexport type { App } from './types/App.js';\n",
      'internal/doubled.ts': 'export function doubled(value: number): number { return value * 2; }\n',
      'render/gl.test.ts': "import { expectReady } from './glTestHelper.js';\nexpectReady({});\n",
      'render/glTestHelper.ts':
        "import { expect } from 'vitest';\nexport function expectReady(value: unknown): void { expect(value).toBeDefined(); }\n",
      'types/App.ts':
        "import type { Bad } from '../bad.js';\nimport type { Child } from './Child.js';\nexport interface App { bad: Bad; child: Child }\n",
      'types/Child.ts': "import type { App } from './App.js';\nexport interface Child { app?: App }\n",
    });
    writeFileSync(
      path.join(workspace, 'package.json'),
      JSON.stringify({ devDependencies: { vitest: '1.0.0' }, name: 'fixture', private: true, version: '1.0.0' }),
    );
    const hoistedVitest = path.join(workspace, 'node_modules', 'vitest');
    mkdirSync(hoistedVitest, { recursive: true });
    writeFileSync(
      path.join(hoistedVitest, 'package.json'),
      JSON.stringify({ exports: './index.js', name: 'vitest', types: './index.d.ts', version: '1.0.0' }),
    );
    writeFileSync(path.join(hoistedVitest, 'index.d.ts'), 'export declare function expect(value: unknown): unknown;\n');
    const reportFile = path.join(workspace, 'check-report.json');

    const exitCode = validateCompilerCommandLineCheckDirectory([
      workspace,
      '--target',
      'rust',
      '--format',
      'json',
      '--report',
      reportFile,
    ]);

    expect(exitCode).toBe(1);
    const result = JSON.parse(readFileSync(reportFile, 'utf8')) as {
      readonly exitCode: number;
      readonly report: {
        readonly cascades: readonly {
          readonly directFindingIdentities: readonly string[];
          readonly module: { readonly source: string };
        }[];
        readonly directFindings: readonly { readonly identity: string; readonly module: { readonly source: string } }[];
        readonly schema: string;
        readonly totals: {
          readonly dependencyCascades: number;
          readonly directFindings: number;
          readonly modules: {
            readonly dependencyRefused: number;
            readonly directlyRefused: number;
            readonly emitted: number;
            readonly total: number;
          };
        };
      };
      readonly schema: string;
    };

    expect(result).toMatchObject({
      exitCode: 1,
      report: {
        schema: 'flight-compiler-check-report/1',
        totals: {
          dependencyCascades: 3,
          directFindings: 1,
          modules: { dependencyRefused: 3, directlyRefused: 1, emitted: 1, total: 5 },
        },
      },
      schema: 'flight-compiler-check-run/1',
    });
    expect(result.report.directFindings.map((finding) => finding.module.source)).toEqual(['packages/core/src/bad.ts']);
    expect(result.report.cascades.map((cascade) => cascade.module.source)).toEqual([
      'packages/core/src/index.ts',
      'packages/core/src/types/App.ts',
      'packages/core/src/types/Child.ts',
    ]);
    expect(result.report.cascades.map((cascade) => cascade.directFindingIdentities)).toEqual(
      result.report.cascades.map(() => [result.report.directFindings[0]!.identity]),
    );
    expect(JSON.stringify(result.report)).not.toContain('gl.test');
    expect(JSON.stringify(result.report)).not.toContain('glTestHelper');
  });

  it('checks the roots the workspace manifest declares', () => {
    const workspace = createWorkspace({
      'index.ts': 'export function doubled(value: number): number { return value * 2; }',
    });
    const other = path.join(workspace, 'packages', 'other');
    mkdirSync(path.join(other, 'src'), { recursive: true });
    writeFileSync(
      path.join(other, 'package.json'),
      JSON.stringify({
        name: '@flighthq/other',
        version: '1.0.0',
        exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
      }),
    );
    writeFileSync(path.join(other, 'src', 'index.ts'), 'export const ready = Promise.resolve(1);\nawait ready;\n');
    writeFileSync(
      path.join(workspace, 'package.json'),
      JSON.stringify({ name: '@flighthq/smoke', version: '0.0.0', dependencies: { '@flighthq/core': '*' } }),
    );

    // The refusing module belongs to a package the workspace does not depend on, so it is not a root and the
    // run admits what it did check.
    expect(validateCompilerCommandLineCheckDirectory([workspace, '--target', 'rust'])).toBe(0);
    expect(
      validateCompilerCommandLineCheckDirectory([workspace, '--target', 'rust', '--package', '@flighthq/other']),
    ).toBe(1);
  });

  it('reports the checked workspace own commit, and unversioned for a directory that is not a checkout', () => {
    const workspace = createWorkspace({
      'index.ts': 'export function doubled(value: number): number { return value * 2; }',
    });
    const report = path.join(workspace, 'check-report.json');
    git(workspace, 'init');
    git(workspace, 'config', 'user.email', 'compiler@example.invalid');
    git(workspace, 'config', 'user.name', 'Compiler Fixture');
    git(workspace, 'add', '.');
    git(workspace, 'commit', '-m', 'fixture');
    const commit = execFileSync('git', ['-C', workspace, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

    const checkoutRun = validateCompilerCommandLineCheckDirectory([
      workspace,
      '--target',
      'rust',
      '--format',
      'json',
      '--report',
      report,
    ]);
    const plain = createWorkspace({
      'index.ts': 'export function doubled(value: number): number { return value * 2; }',
    });
    const plainReport = path.join(plain, 'check-report.json');
    const plainRun = validateCompilerCommandLineCheckDirectory([
      plain,
      '--target',
      'rust',
      '--format',
      'json',
      '--report',
      plainReport,
    ]);

    expect(checkoutRun).toBe(0);
    expect(plainRun).toBe(0);
    expect(JSON.parse(readFileSync(report, 'utf8')) as unknown).toMatchObject({
      report: { provenance: { upstream: { name: 'workspace', revision: commit } } },
    });
    expect(JSON.parse(readFileSync(plainReport, 'utf8')) as unknown).toMatchObject({
      report: { provenance: { upstream: { name: 'workspace', revision: 'unversioned' } } },
    });
  });

  it('fails loudly when pointed at a directory that holds no workspace', () => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'flight-command-line-check-'));
    workspaces.push(workspace);

    expect(validateCompilerCommandLineCheckDirectory([workspace, '--target', 'rust'])).toBe(2);
    expect(validateCompilerCommandLineCheckDirectory([path.join(workspace, 'absent'), '--target', 'rust'])).toBe(2);
  });
});
