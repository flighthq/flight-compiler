import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { compileCompilerCommandLineDirectory } from './compilerCommandLineEntryPoint.js';

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
