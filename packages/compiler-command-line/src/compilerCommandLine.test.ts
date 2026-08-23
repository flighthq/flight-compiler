import { describe, expect, it } from 'vitest';

import type { CompilerCommandLineCapabilities, CompilerCommandLineSource } from '../../compiler-types/src/index.js';
import {
  getCompilerCommandLineUsage,
  createCompilerCommandLineReport,
  compileCompilerCommandLineRequest,
} from './compilerCommandLine.js';

describe('compileCompilerCommandLineRequest', () => {
  it('compiles every module it is pointed at and writes what each one emitted', () => {
    const written = new Map<string, string>();
    const out: string[] = [];
    const result = compileCompilerCommandLineRequest(
      { argv: ['/src', '--target', 'haxe', '--out', '/out'] },
      capabilities(
        [
          source('add.ts', 'export function add(left: number, right: number): number { return left + right; }'),
          source('negate.ts', 'export function negate(value: number): number { return -value; }'),
        ],
        written,
        out,
      ),
    );

    expect(result).toMatchObject({ emitted: 2, exitCode: 0, refusals: [] });
    expect([...written.keys()]).toEqual(['/out/flighthq/source/Add.hx', '/out/flighthq/source/Negate.hx']);
    expect(written.get('/out/flighthq/source/Add.hx')).toContain('public static function add(');
    expect(out.join('')).toContain('2 module(s) emitted, 0 refused.');
  });

  it('records what it could not compile and keeps going, because a refusal is the answer', () => {
    const written = new Map<string, string>();
    const result = compileCompilerCommandLineRequest(
      { argv: ['/src', '--target', 'rust', '--out', '/out'] },
      capabilities(
        [
          source('good.ts', 'export function good(value: number): number { return value; }'),
          // `reduce` has no Haxe binding and a regular expression has no target mapping at all: the
          // run reports both rather than stopping at the first one.
          source('bad.ts', 'export function bad(): RegExp { return /x/; }'),
        ],
        written,
        [],
      ),
    );

    expect(result.emitted).toBe(1);
    expect(result.exitCode).toBe(1);
    expect(result.refusals).toHaveLength(1);
    expect(result.refusals[0]?.module).toBe('bad.ts');
  });

  it('reports without failing when asked to report', () => {
    const result = compileCompilerCommandLineRequest(
      { argv: ['/src', '--target', 'rust', '--out', '/out', '--report'] },
      capabilities([source('bad.ts', 'export function bad(): RegExp { return /x/; }')], new Map(), []),
    );

    expect(result.refusals).toHaveLength(1);
    expect(result.exitCode).toBe(0);
  });

  it('refuses an incomplete invocation with the usage rather than a stack', () => {
    const errors: string[] = [];
    const missingTarget = compileCompilerCommandLineRequest(
      { argv: ['/src', '--out', '/out'] },
      { ...capabilities([], new Map(), []), writeError: (text) => errors.push(text) },
    );
    const missingDirectory = compileCompilerCommandLineRequest(
      { argv: ['--target', 'haxe', '--out', '/out'] },
      { ...capabilities([], new Map(), []), writeError: (text) => errors.push(text) },
    );

    expect(missingTarget.exitCode).toBe(2);
    expect(missingDirectory.exitCode).toBe(2);
    expect(errors.join('')).toContain('--target must be haxe or rust');
    expect(errors.join('')).toContain(getCompilerCommandLineUsage());
  });

  it('says so when there is nothing to compile, rather than reporting a successful empty run', () => {
    const errors: string[] = [];
    const result = compileCompilerCommandLineRequest(
      { argv: ['/src', '--target', 'haxe', '--out', '/out'] },
      { ...capabilities([], new Map(), []), writeError: (text) => errors.push(text) },
    );

    expect(result.exitCode).toBe(2);
    expect(errors.join('')).toContain('No TypeScript modules under /src');
  });
});

describe('createCompilerCommandLineReport', () => {
  it('groups modules by the reason they were refused, most-blocking first', () => {
    const report = createCompilerCommandLineReport(1, [
      { module: 'a.ts', reason: 'no binding for reduce' },
      { module: 'b.ts', reason: 'unsupported regular expression' },
      { module: 'c.ts', reason: 'no binding for reduce' },
    ]);

    expect(report).toContain('1 module(s) emitted, 3 refused.');
    expect(report.indexOf('2x no binding for reduce')).toBeLessThan(report.indexOf('1x unsupported'));
  });

  it('samples the modules behind a reason rather than listing every one', () => {
    const report = createCompilerCommandLineReport(
      0,
      Array.from({ length: 7 }, (_, index) => ({ module: `m${String(index)}.ts`, reason: 'one reason' })),
    );

    expect(report).toContain('7x one reason');
    expect(report).toContain('… and 4 more');
  });
});

function capabilities(
  sources: readonly CompilerCommandLineSource[],
  written: Map<string, string>,
  out: string[],
): CompilerCommandLineCapabilities {
  return {
    listSourceFiles: () => sources,
    write: (text) => out.push(text),
    writeError: () => undefined,
    writeOutputFile: (directory, relativePath, contents) => written.set(`${directory}/${relativePath}`, contents),
  };
}

function source(moduleName: string, contents: string): CompilerCommandLineSource {
  return { contents, moduleName, sourcePath: `/src/${moduleName}` };
}

describe('getCompilerCommandLineUsage', () => {
  it('names every option the parser accepts, so the usage cannot drift from the parser', () => {
    const usage = getCompilerCommandLineUsage();

    expect(usage).toContain('--target');
    expect(usage).toContain('--out');
    expect(usage).toContain('--package');
    expect(usage).toContain('--report');
  });
});
