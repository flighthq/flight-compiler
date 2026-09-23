import { describe, expect, it } from 'vitest';

import type {
  CompilerCommandLineCapabilities,
  CompilerCommandLineCheckCapabilities,
  CompilerCommandLineSource,
  CompilerCommandLineWorkspacePackage,
} from '../../compiler-types/src/index.js';
import {
  validateCompilerCommandLineCheckRequest,
  compileCompilerCommandLineRequest,
  createCompilerCommandLineCheckReport,
  createCompilerCommandLineReport,
  getCompilerCommandLineCheckUsage,
  getCompilerCommandLineUsage,
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
    expect(written.get('/out/consumer.hpp')).toContain('flight::Ref<flighthq_source::Model>');
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

  it('passes the emission mode through to the Haxe backend and defaults to transpilation', () => {
    const external = new Map<string, string>();
    const transpiled = new Map<string, string>();
    const input = source('value.ts', 'export function value(): number { return 1; }');

    expect(
      compileCompilerCommandLineRequest(
        { argv: ['/src', '--target', 'haxe', '--out', '/extern', '--emission-mode', 'extern'] },
        capabilities([input], external, []),
      ).exitCode,
    ).toBe(0);
    expect(
      compileCompilerCommandLineRequest(
        { argv: ['/src', '--target', 'haxe', '--out', '/transpile'] },
        capabilities([input], transpiled, []),
      ).exitCode,
    ).toBe(0);

    expect(external.get('/extern/flighthq/_js/_fn/Source.hx')).toContain('extern class Source');
    expect(external.get('/extern/flighthq/_js/_fn/Source.hx')).toContain('@:jsImport("@local/source/contract")');
    expect(external.get('/extern/flighthq/_js/_fn/Source.hx')).not.toContain('return 1;');
    expect(transpiled.get('/transpile/flighthq/source/Value.hx')).toContain('return 1;');
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
      ['/src', '--target', 'haxe', '--out', '/out', '--emission-mode', 'unknown'],
      ['/src', '--target', 'cpp', '--out', '/out', '--emission-mode', 'extern'],
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
    expect(errors.join('')).toContain('--emission-mode must be extern or transpile');
    expect(errors.join('')).toContain('--emission-mode requires --target haxe');
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

describe('validateCompilerCommandLineCheckRequest', () => {
  // A workspace with one package that compiles and one module that does not: the shape a check run is
  // actually pointed at, and the one where "what gates" has an answer.
  const workspacePackage = (name: string, environments: readonly string[] = []) => ({
    environments,
    name,
    root: `/ws/${name}`,
  });
  const rustModule = 'export function doubled(value: number): number { return value * 2; }';
  const refusedModule = 'export function bad(): RegExp { return /x/; }';

  it('reports a finding and exits 1 when a module cannot be compiled', () => {
    const run = checkRun([source('good.ts', rustModule), source('bad.ts', refusedModule)]);

    const result = validateCompilerCommandLineCheckRequest({ argv: ['/ws/one', '--target', 'rust'] }, run.capabilities);

    expect(result.exitCode).toBe(1);
    expect(result.packages).toEqual(['one']);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.module).toBe('bad.ts');
    expect(result.findings[0]?.stage).toBe('emission');
    expect(result.introduced).toEqual(result.findings);
    expect(run.out.join('')).toContain('1 gating');
  });

  it('admits the workspace when the only finding is the runtime to supply', () => {
    const run = checkRun([source('bad.ts', refusedModule)], { runtimeOnly: true });

    const result = validateCompilerCommandLineCheckRequest({ argv: ['/ws/one', '--target', 'rust'] }, run.capabilities);

    expect(result.exitCode).toBe(0);
    expect(result.runtimeOnly).toBe(1);
    expect(result.introduced).toHaveLength(1);
    expect(run.out.join('')).toContain('1 runtime-only');
  });

  it('admits a finding the baseline already carried and still reports it', () => {
    const run = checkRun([source('bad.ts', refusedModule)]);
    const first = validateCompilerCommandLineCheckRequest({ argv: ['/ws/one', '--target', 'rust'] }, run.capabilities);
    const baseline = first.findings.map((finding) => finding.id).join('\n');
    const ids = first.findings.map((finding) => finding.id);

    const resumed = checkRun([source('bad.ts', refusedModule)], { baseline: `${baseline}\n` });
    const result = validateCompilerCommandLineCheckRequest(
      { argv: ['/ws/one', '--target', 'rust', '--baseline', '/ws/check.baseline'] },
      resumed.capabilities,
    );

    expect(ids).toHaveLength(1);
    expect(result.exitCode).toBe(0);
    expect(result.baselined).toBe(1);
    expect(result.introduced).toEqual([]);
    expect(result.resolved).toEqual([]);
  });

  it('distinguishes an introduced finding from one the baseline no longer covers', () => {
    const run = checkRun([source('bad.ts', refusedModule)], {
      baseline: 'gone.ts::a reason that no longer happens:3:1\n',
    });

    const result = validateCompilerCommandLineCheckRequest(
      { argv: ['/ws/one', '--target', 'rust', '--baseline', '/ws/check.baseline'] },
      run.capabilities,
    );

    expect(result.exitCode).toBe(1);
    expect(result.baselined).toBe(0);
    expect(result.introduced).toHaveLength(1);
    expect(result.resolved).toEqual(['gone.ts::a reason that no longer happens:3:1']);
  });

  it('selects unmarked packages by default and named environments only when asked', () => {
    const marked = { environments: ['web'], name: 'web', root: '/ws/web' };
    const unmarked = { environments: [], name: 'core', root: '/ws/core' };
    const run = checkRun([source('only.ts', rustModule)], { packages: [marked, unmarked] });

    const byDefault = validateCompilerCommandLineCheckRequest({ argv: ['/ws', '--target', 'rust'] }, run.capabilities);
    const selected = validateCompilerCommandLineCheckRequest(
      { argv: ['/ws', '--target', 'rust', '--environment', 'web'] },
      run.capabilities,
    );

    expect(byDefault.packages).toEqual(['core']);
    expect(selected.packages).toEqual(['web']);
  });

  it('accepts a repeated environment without letting repetition change the answer', () => {
    const marked = { environments: ['web', 'mobile'], name: 'platform', root: '/ws/platform' };
    const run = checkRun([source('only.ts', rustModule)], { packages: [marked] });

    const once = validateCompilerCommandLineCheckRequest(
      { argv: ['/ws', '--target', 'rust', '--environment', 'web'] },
      run.capabilities,
    );
    const twice = validateCompilerCommandLineCheckRequest(
      { argv: ['/ws', '--target', 'rust', '--environment', 'web', '--environment', 'mobile'] },
      run.capabilities,
    );

    expect(once.packages).toEqual(['platform']);
    expect(twice.packages).toEqual(['platform']);
    expect(twice.exitCode).toBe(once.exitCode);
  });

  it('refuses an invocation that names an environment no package declares', () => {
    const run = checkRun([source('only.ts', rustModule)], { packages: [workspacePackage('core')] });

    const result = validateCompilerCommandLineCheckRequest(
      { argv: ['/ws', '--target', 'rust', '--environment', 'web'] },
      run.capabilities,
    );

    expect(result.exitCode).toBe(2);
    expect(result.findings).toEqual([]);
    expect(run.err.join('')).toContain('declares web');
  });

  it('treats an empty workspace as an invocation failure rather than a clean run', () => {
    const run = checkRun([], { packages: [workspacePackage('core')] });

    const result = validateCompilerCommandLineCheckRequest({ argv: ['/ws', '--target', 'rust'] }, run.capabilities);

    expect(result.exitCode).toBe(2);
    expect(run.err.join('')).toContain('No TypeScript modules');
  });

  it('refuses an invocation it cannot parse without compiling anything', () => {
    const run = checkRun([source('only.ts', rustModule)]);

    const missingOut = validateCompilerCommandLineCheckRequest(
      { argv: ['/ws', '--target', 'rust', '--out', '/out'] },
      run.capabilities,
    );
    const missingTarget = validateCompilerCommandLineCheckRequest({ argv: ['/ws'] }, run.capabilities);

    expect(missingOut.exitCode).toBe(2);
    expect(missingTarget.exitCode).toBe(2);
    expect(run.err.join('')).toContain('Unknown option --out');
    expect(run.out.join('')).toBe('');
  });

  it('keeps the JSON report byte-identical between runs of the same workspace', () => {
    const first = checkRun([source('bad.ts', refusedModule)]);
    const second = checkRun([source('bad.ts', refusedModule)]);

    const json = (run: ReturnType<typeof checkRun>): string => String(run.out.join(''));
    validateCompilerCommandLineCheckRequest(
      { argv: ['/ws/one', '--target', 'rust', '--format', 'json'] },
      first.capabilities,
    );
    validateCompilerCommandLineCheckRequest(
      { argv: ['/ws/one', '--target', 'rust', '--format', 'json'] },
      second.capabilities,
    );

    expect(json(first)).toBe(json(second));
    expect(json(first)).toContain('"schema": "flight-compiler-check/1"');
    expect(json(first).indexOf('"code"')).toBeLessThan(json(first).indexOf('"module"'));
  });

  it('writes the named report file and still prints the result to the stream', () => {
    const run = checkRun([source('bad.ts', refusedModule)]);

    const result = validateCompilerCommandLineCheckRequest(
      { argv: ['/ws/one', '--target', 'rust', '--report', '/ws/check.txt'] },
      run.capabilities,
    );

    expect(result.exitCode).toBe(1);
    expect([...run.reports.keys()]).toEqual(['/ws/check.txt']);
    expect(run.reports.get('/ws/check.txt')).toContain('bad.ts');
    expect(run.out.join('')).toContain('1 package(s) checked');
    expect(run.out.join('')).not.toContain('bad.ts');
  });
});

describe('getCompilerCommandLineCheckUsage', () => {
  it('names every option the check parser accepts, so the usage cannot drift from the parser', () => {
    const usage = getCompilerCommandLineCheckUsage();

    expect(usage).toContain('--target');
    expect(usage).toContain('--environment');
    expect(usage).toContain('--baseline');
    expect(usage).toContain('--format');
    expect(usage).toContain('--report');
    expect(usage).not.toContain('--out');
  });
});

describe('createCompilerCommandLineCheckReport', () => {
  const finding = {
    code: 'unsupported-ir' as const,
    id: 'a.ts::zebra',
    module: 'a.ts',
    reason: 'zebra reason',
    stage: 'emission' as const,
  };

  it('says what gated and what was already known before it lists either', () => {
    const report = createCompilerCommandLineCheckReport({
      baselined: 2,
      exitCode: 1,
      findings: [finding],
      introduced: [finding],
      packages: ['one'],
      resolved: [],
      runtimeOnly: 0,
    });

    expect(report.indexOf('1 package(s) checked')).toBeLessThan(report.indexOf('zebra reason'));
    expect(report).toContain('1 gating');
  });
});

// Check mode's capabilities, with no output-directory member at all: a check that tried to write a
// generated source could not compile, which is a stronger statement than a test asserting it did not.
function checkRun(
  sources: readonly CompilerCommandLineSource[],
  options: Readonly<{
    baseline?: string | undefined;
    packages?: readonly CompilerCommandLineWorkspacePackage[] | undefined;
    runtimeOnly?: boolean | undefined;
  }> = {},
): Readonly<{
  capabilities: CompilerCommandLineCheckCapabilities;
  err: string[];
  out: string[];
  reports: Map<string, string>;
}> {
  const out: string[] = [];
  const err: string[] = [];
  const reports = new Map<string, string>();
  const packages = options.packages ?? [{ environments: [], name: 'one', root: '/ws/one' }];
  // The graph checks that every source sits inside the package root it was declared with, so the shared
  // `source` helper (whose paths are /src/...) is rebased onto whichever root this run selected.
  const rebased = packages.map((entry) => ({
    root: entry.root,
    sources: sources.map((entry0) => ({ ...entry0, sourcePath: `${entry.root}/${entry0.moduleName}` })),
  }));
  return {
    capabilities: {
      listSourceFiles: (directory) => rebased.find((entry) => entry.root === directory)?.sources ?? [],
      listWorkspacePackages: () => packages,
      readBaseline: (file) => (file === '/ws/check.baseline' ? options.baseline : undefined),
      ...(options.runtimeOnly === true ? { isRuntimeOnlyFinding: () => true } : {}),
      write: (text) => out.push(text),
      writeError: (text) => err.push(text),
      writeReportFile: (file, contents) => reports.set(file, contents),
    },
    err,
    out,
    reports,
  };
}
