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
    expect(written.get('/out/flighthq/source/Add.hx')).toContain('function add(');
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
    expect(result.refusals[0]).toMatchObject({ code: 'unsupported-ir', module: 'bad.ts', stage: 'emission' });
    expect(result.refusals[0]).not.toHaveProperty('column');
    expect(result.refusals[0]).not.toHaveProperty('line');
  });

  it('compiles sibling imports as one graph so cross-module type identity reaches the backend', () => {
    const written = new Map<string, string>();
    const result = compileCompilerCommandLineRequest(
      { argv: ['/src', '--target', 'cpp', '--out', '/out'] },
      capabilities(
        [
          source('model.ts', 'export interface Model { value: number }'),
          source(
            'consumer.ts',
            "import type { Model } from './model.js'; export interface Extended extends Model { label: string } export function same(left: Model, right: Model): boolean { return left === right; }",
          ),
        ],
        written,
        [],
      ),
    );

    expect(result).toMatchObject({ emitted: 2, exitCode: 0, refusals: [] });
    expect(written.get('/out/consumer.hpp')).toContain('#include "model.hpp"');
    expect(written.get('/out/consumer.hpp')).toContain('flight::Ref<Model>');
    expect(written.get('/out/consumer.hpp')).toContain('double value;');
    expect(written.get('/out/consumer.hpp')).toContain('flight::String label;');
  });

  it('reports without failing when asked to report', () => {
    const result = compileCompilerCommandLineRequest(
      { argv: ['/src', '--target', 'rust', '--out', '/out', '--report'] },
      capabilities([source('bad.ts', 'export function bad(): RegExp { return /x/; }')], new Map(), []),
    );

    expect(result.refusals).toHaveLength(1);
    expect(result.exitCode).toBe(0);
  });

  it('passes the root-package option through to the Haxe backend', () => {
    const written = new Map<string, string>();
    const result = compileCompilerCommandLineRequest(
      { argv: ['/src', '--target', 'haxe', '--out', '/out', '--root-package', 'com.example'] },
      capabilities([source('value.ts', 'export function value(): number { return 1; }')], written, []),
    );

    expect(result).toMatchObject({ emitted: 1, exitCode: 0, refusals: [] });
    expect([...written.keys()][0]).toContain('com/example');
  });

  it('elects the semantic C++ runtime by default and permits an explicit compatibility profile', () => {
    const semantic = new Map<string, string>();
    const standard = new Map<string, string>();
    const input = source('label.ts', 'export function label(): string { return "flight"; }');

    expect(
      compileCompilerCommandLineRequest(
        { argv: ['/src', '--target', 'cpp', '--out', '/semantic'] },
        capabilities([input], semantic, []),
      ).exitCode,
    ).toBe(0);
    expect(
      compileCompilerCommandLineRequest(
        {
          argv: ['/src', '--target', 'cpp', '--out', '/standard', '--runtime-profile', 'standard-library'],
        },
        capabilities([input], standard, []),
      ).exitCode,
    ).toBe(0);

    expect(semantic.get('/semantic/label.hpp')).toContain('#include <flight/runtime.hpp>');
    expect(semantic.get('/semantic/label.hpp')).toContain('flight::String label()');
    expect(standard.get('/standard/label.hpp')).toContain('std::string label()');
    expect(standard.get('/standard/label.hpp')).not.toContain('flight/runtime.hpp');
  });

  it('passes a valid runtime-header through to the C++ backend options', () => {
    const written = new Map<string, string>();
    const result = compileCompilerCommandLineRequest(
      {
        argv: [
          '/src',
          '--target',
          'cpp',
          '--out',
          '/out',
          '--runtime-profile',
          'flight-cpp',
          '--runtime-header',
          'custom/runtime.hpp',
        ],
      },
      capabilities([source('value.ts', 'export function value(): number { return 1; }')], written, []),
    );

    expect(result).toMatchObject({ emitted: 1, exitCode: 0, refusals: [] });
    expect(written.get('/out/value.hpp')).toContain('#include "custom/runtime.hpp"');
  });

  it('rejects runtime-header values with characters unsafe for quoted includes', () => {
    const errors: string[] = [];
    const unsafe = ['', '"bad.hpp', '<bad>.hpp', 'bad\npath.hpp'];
    for (const header of unsafe) {
      compileCompilerCommandLineRequest(
        { argv: ['/src', '--target', 'cpp', '--out', '/out', '--runtime-header', header] },
        { ...capabilities([], new Map(), []), writeError: (text) => errors.push(text) },
      );
    }
    for (const error of errors) {
      expect(error).toContain('portable quoted-include path');
    }
  });

  it('validates target-specific and source-generating options before compiling', () => {
    const errors: string[] = [];
    const invalidRequests = [
      ['/src', '--target', 'cpp', '--out', '/out', '--runtime-profile', 'unknown'],
      ['/src', '--target', 'haxe', '--out', '/out', '--runtime-profile', 'flight-cpp'],
      ['/src', '--target', 'cpp', '--out', '/out', '--runtime-header', '../bad\\runtime.hpp'],
      ['/src', '--target', 'rust', '--out', '/out', '--root-package', 'flight'],
      ['/src', '--target', 'rust', '--out', '/out', '--unknown', 'value'],
      ['/src', '/other', '--target', 'rust', '--out', '/out'],
      ['/src', '--target', 'cpp', '--out', '/out', '--target', 'haxe'],
      ['/src', '--target', 'cpp', '--out'],
      ['/src', '--target', 'haxe'],
      [
        '/src',
        '--target',
        'cpp',
        '--out',
        '/out',
        '--runtime-profile',
        'standard-library',
        '--runtime-header',
        'custom.hpp',
      ],
    ];

    for (const argv of invalidRequests) {
      const result = compileCompilerCommandLineRequest(
        { argv },
        { ...capabilities([], new Map(), []), writeError: (text) => errors.push(text) },
      );
      expect(result.exitCode).toBe(2);
    }

    expect(errors.join('')).toContain('--runtime-profile must be flight-cpp or standard-library');
    expect(errors.join('')).toContain('require --target cpp');
    expect(errors.join('')).toContain('portable quoted-include path');
    expect(errors.join('')).toContain('--root-package requires --target haxe');
    expect(errors.join('')).toContain('Unknown option --unknown');
    expect(errors.join('')).toContain('Exactly one source directory is required');
    expect(errors.join('')).toContain('may be supplied once');
    expect(errors.join('')).toContain('requires a value');
    expect(errors.join('')).toContain('--out is required');
    expect(errors.join('')).toContain('--runtime-header requires the flight-cpp runtime profile');
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
    expect(errors.join('')).toContain('--target must be cpp, haxe, or rust');
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

  it('breaks ties by reason text when two rules block the same number of modules', () => {
    const report = createCompilerCommandLineReport(0, [
      { module: 'a.ts', reason: 'zebra reason' },
      { module: 'b.ts', reason: 'alpha reason' },
    ]);

    expect(report.indexOf('alpha reason')).toBeLessThan(report.indexOf('zebra reason'));
  });

  it('samples the modules behind a reason rather than listing every one', () => {
    const report = createCompilerCommandLineReport(
      0,
      Array.from({ length: 7 }, (_, index) => ({ module: `m${String(index)}.ts`, reason: 'one reason' })),
    );

    expect(report).toContain('7x one reason');
    expect(report).toContain('… and 4 more');
  });

  it('lists all modules when exactly at the sample size without a truncation line', () => {
    const report = createCompilerCommandLineReport(
      0,
      Array.from({ length: 3 }, (_, index) => ({ module: `m${String(index)}.ts`, reason: 'one reason' })),
    );

    expect(report).toContain('3x one reason');
    expect(report).not.toContain('… and');
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
    expect(usage).toContain('--runtime-header');
    expect(usage).toContain('--runtime-profile');
    expect(usage).toContain('--report');
  });
});
