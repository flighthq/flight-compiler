import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  validateCompilerCommandLineCheckDirectory,
  compileCompilerCommandLineDirectory,
} from './compilerCommandLineEntryPoint.js';

const workspaces: string[] = [];

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

describe('validateCompilerCommandLineCheckDirectory', () => {
  // A check run reads the workspace and leaves it alone. The generated-source capability is not part of
  // the check's record at all, so the strongest statement the test can make is the tree it started with.
  it('checks a workspace without writing a generated source beside it', () => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'flight-command-line-check-'));
    workspaces.push(workspace);
    writeFileSync(
      path.join(workspace, 'good.ts'),
      'export function doubled(value: number): number { return value * 2; }',
    );
    writeFileSync(path.join(workspace, 'bad.ts'), 'export function bad(): RegExp { return /x/; }');
    const before = readdirSync(workspace, { recursive: true }).map(String).sort();

    const exitCode = validateCompilerCommandLineCheckDirectory([workspace, '--target', 'rust']);

    expect(exitCode).toBe(1);
    expect(readdirSync(workspace, { recursive: true }).map(String).sort()).toEqual(before);
  });

  it('admits a workspace whose modules all compile', () => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'flight-command-line-check-'));
    workspaces.push(workspace);
    writeFileSync(
      path.join(workspace, 'good.ts'),
      'export function doubled(value: number): number { return value * 2; }',
    );

    expect(validateCompilerCommandLineCheckDirectory([workspace, '--target', 'cpp'])).toBe(0);
  });

  it('writes the report it was asked for and nothing else', () => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'flight-command-line-check-'));
    workspaces.push(workspace);
    writeFileSync(path.join(workspace, 'bad.ts'), 'export function bad(): RegExp { return /x/; }');
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
    expect(readFileSync(report, 'utf8')).toContain('"schema": "flight-compiler-check/1"');
    expect(readdirSync(workspace, { recursive: true }).map(String).sort()).toEqual(['bad.ts', 'check-report.json']);
  });

  it('fails loudly when pointed at a directory that holds no workspace', () => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'flight-command-line-check-'));
    workspaces.push(workspace);

    expect(validateCompilerCommandLineCheckDirectory([path.join(workspace, 'absent'), '--target', 'rust'])).toBe(2);
  });
});
