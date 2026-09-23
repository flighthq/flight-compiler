import { describe, expect, it } from 'vitest';

import {
  createCompilerPackageCheckPolicyResult,
  createCompilerPackageCheckPolicyStrict,
  createCompilerPackageCheckReport,
} from '../../compiler-check/src/index.js';
import { createMemoryWorkspaceSource } from '../../compiler-inventory/src/index.js';
import type {
  CompilerCommandLineCapabilities,
  CompilerCommandLineCheckCapabilities,
  CompilerCommandLineCheckOutcome,
  CompilerCommandLineCheckResult,
  CompilerCommandLineSource,
  CompilerPackageCheckComparison,
  CompilerPackageCheckProvenance,
} from '../../compiler-types/src/index.js';
import {
  validateCompilerCommandLineCheckRequest,
  compileCompilerCommandLineRequest,
  createCompilerCommandLineCheckReport,
  createCompilerCommandLineReport,
  getCompilerCommandLineCheckUsage,
  getCompilerCommandLineUsage,
  isCompilerCommandLineCheckRefusal,
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
  // A workspace the inventory reads: every fixture package declares the root export lane a real package
  // has, and the modules behind it are where a finding is found.
  const goodModule = 'export function doubled(value: number): number { return value * 2; }';
  const refusedModule = 'export function bad(): RegExp { return /x/; }';
  const core: CheckPackage = {
    directory: 'core',
    name: '@flighthq/core',
    sources: { 'bad.ts': refusedModule, 'index.ts': "export * from './bad.js';\n" },
  };
  const quiet: CheckPackage = { directory: 'quiet', name: '@flighthq/quiet', sources: { 'index.ts': goodModule } };
  // The identity the check package mints for the refused module, spelled out so a baseline fixture is a
  // literal rather than something the test derives from the code it is testing.
  const refusedIdentity =
    'flight-compiler-check-finding/1:["@flighthq/core","packages/core/src/bad.ts","Bad","emission","unsupported-ir",null]';

  it('reports a finding and exits 1 when a module cannot be compiled', () => {
    const run = checkRun([core]);

    const result = validateCompilerCommandLineCheckRequest({ argv: ['/ws', '--target', 'rust'] }, run.capabilities);

    expect(result.exitCode).toBe(1);
    expect(checkOutcome(result).eligiblePackageNames).toEqual(['@flighthq/core']);
    expect(checkOutcome(result).report.directFindings.map((finding) => finding.module.source)).toEqual([
      'packages/core/src/bad.ts',
    ]);
    expect(checkOutcome(result).comparison.introduced).toEqual(checkOutcome(result).report.directFindings);
    expect(run.out.join('')).toContain('1 gating');
  });

  it('admits a workspace whose modules all compile', () => {
    const run = checkRun([quiet]);

    const result = validateCompilerCommandLineCheckRequest({ argv: ['/ws', '--target', 'rust'] }, run.capabilities);

    expect(result.exitCode).toBe(0);
    expect(checkOutcome(result).report.directFindings).toEqual([]);
    expect(run.out.join('')).toContain('0 gating');
  });

  it('admits a finding the baseline already carried and still reports it', () => {
    const baseline = JSON.stringify({
      findingIdentities: [refusedIdentity],
      schema: 'flight-compiler-check-baseline/1',
    });
    const run = checkRun([core], { baseline });

    const result = validateCompilerCommandLineCheckRequest(
      { argv: ['/ws', '--target', 'rust', '--baseline', '/ws/check.baseline'] },
      run.capabilities,
    );

    expect(result.exitCode).toBe(0);
    expect(checkOutcome(result).comparison.introduced).toEqual([]);
    expect(checkOutcome(result).comparison.unchanged).toHaveLength(1);
    expect(checkOutcome(result).report.directFindings).toHaveLength(1);
    expect(run.out.join('')).toContain('1 baselined');
  });

  it('distinguishes an introduced finding from one the baseline no longer covers', () => {
    const run = checkRun([core], {
      baseline: '{"schema":"flight-compiler-check-baseline/1","findingIdentities":["gone"]}',
    });

    const result = validateCompilerCommandLineCheckRequest(
      { argv: ['/ws', '--target', 'rust', '--baseline', '/ws/check.baseline'] },
      run.capabilities,
    );

    expect(result.exitCode).toBe(1);
    expect(checkOutcome(result).comparison.unchanged).toEqual([]);
    expect(checkOutcome(result).comparison.introduced).toHaveLength(1);
    expect(checkOutcome(result).comparison.resolvedFindingIdentities).toEqual(['gone']);
  });

  it('refuses a baseline it cannot read or understand rather than comparing against nothing', () => {
    const absent = checkRun([core]);
    const malformed = checkRun([core], { baseline: 'not json' });
    const foreign = checkRun([core], {
      baseline: '{"schema":"flight-compiler-check-baseline/2","findingIdentities":[]}',
    });
    const argv = ['/ws', '--target', 'rust', '--baseline', '/ws/check.baseline'];

    const missingResult = validateCompilerCommandLineCheckRequest({ argv }, absent.capabilities);
    const malformedResult = validateCompilerCommandLineCheckRequest({ argv }, malformed.capabilities);
    const foreignResult = validateCompilerCommandLineCheckRequest({ argv }, foreign.capabilities);

    expect(missingResult.exitCode).toBe(2);
    expect(malformedResult.exitCode).toBe(2);
    expect(foreignResult.exitCode).toBe(2);
    expect(absent.err.join('')).toContain('could not be read');
    expect(malformed.err.join('')).toContain('is not valid JSON');
    expect(foreign.err.join('')).toContain('flight-compiler-check-baseline/1');
  });

  it('counts a refused dependency as a cascade rather than as the importing module finding', () => {
    const importer: CheckPackage = {
      dependencies: ['@flighthq/core'],
      directory: 'importer',
      name: '@flighthq/importer',
      sources: { 'index.ts': "import { bad } from '@flighthq/core';\nvoid bad;" },
    };
    const run = checkRun([core, importer]);

    const result = validateCompilerCommandLineCheckRequest({ argv: ['/ws', '--target', 'rust'] }, run.capabilities);

    expect(result.exitCode).toBe(1);
    expect(checkOutcome(result).report.directFindings).toHaveLength(1);
    expect(checkOutcome(result).report.cascades.map((cascade) => cascade.module.source)).toEqual([
      'packages/core/src/index.ts',
      'packages/importer/src/index.ts',
    ]);
    expect(run.out.join('')).toContain('Dependency cascades: 2');
  });

  it('selects unmarked packages by default and named environments only when asked', () => {
    const marked: CheckPackage = {
      directory: 'web',
      environment: 'web',
      name: '@flighthq/web',
      sources: { 'index.ts': goodModule },
    };
    const run = checkRun([marked, quiet]);

    const byDefault = validateCompilerCommandLineCheckRequest({ argv: ['/ws', '--target', 'rust'] }, run.capabilities);
    const selected = validateCompilerCommandLineCheckRequest(
      { argv: ['/ws', '--target', 'rust', '--environment', 'web'] },
      run.capabilities,
    );

    expect(checkOutcome(byDefault).eligiblePackageNames).toEqual(['@flighthq/quiet']);
    expect(checkOutcome(selected).eligiblePackageNames).toEqual(['@flighthq/web']);
  });

  it('excludes an incompatible default root without dropping compatible unmarked packages', () => {
    const web: CheckPackage = {
      directory: 'web',
      environment: 'web',
      name: '@flighthq/web',
      sources: { 'index.ts': goodModule },
    };
    const incompatible: CheckPackage = {
      dependencies: ['@flighthq/web'],
      directory: 'browser-dependent',
      name: '@flighthq/browser-dependent',
      sources: { 'index.ts': "export { doubled } from '@flighthq/web';" },
    };
    const run = checkRun([incompatible, quiet, web]);

    const result = validateCompilerCommandLineCheckRequest(
      { argv: ['/ws', '--target', 'rust'] },
      run.capabilities,
    );

    expect(result.exitCode).toBe(0);
    expect(checkOutcome(result).eligiblePackageNames).toEqual(['@flighthq/quiet']);
  });

  it('unites repeated environments instead of letting the last one win', () => {
    const web: CheckPackage = {
      directory: 'web',
      environment: 'web',
      name: '@flighthq/web',
      sources: { 'index.ts': goodModule },
    };
    const node: CheckPackage = {
      directory: 'node',
      environment: 'node',
      name: '@flighthq/node',
      sources: { 'index.ts': goodModule },
    };
    const run = checkRun([web, node]);

    const once = validateCompilerCommandLineCheckRequest(
      { argv: ['/ws', '--target', 'rust', '--environment', 'web'] },
      run.capabilities,
    );
    const twice = validateCompilerCommandLineCheckRequest(
      { argv: ['/ws', '--target', 'rust', '--environment', 'web', '--environment', 'node'] },
      run.capabilities,
    );

    expect(checkOutcome(once).eligiblePackageNames).toEqual(['@flighthq/web']);
    expect(checkOutcome(twice).eligiblePackageNames).toEqual(['@flighthq/node', '@flighthq/web']);
    expect(twice.exitCode).toBe(once.exitCode);
  });

  it('refuses an invocation that names an environment no package declares', () => {
    const run = checkRun([quiet]);

    const result = validateCompilerCommandLineCheckRequest(
      { argv: ['/ws', '--target', 'rust', '--environment', 'web'] },
      run.capabilities,
    );

    expect(result.exitCode).toBe(2);
    expect(run.err.join('')).toContain('declares web');
  });

  it('checks only the packages a repeated --package names', () => {
    const run = checkRun([core, quiet]);

    const result = validateCompilerCommandLineCheckRequest(
      { argv: ['/ws', '--target', 'rust', '--package', '@flighthq/quiet'] },
      run.capabilities,
    );

    expect(result.exitCode).toBe(0);
    expect(checkOutcome(result).eligiblePackageNames).toEqual(['@flighthq/quiet']);
  });

  it('refuses a named package whose environment was not selected, naming the environment it needs', () => {
    const web: CheckPackage = {
      directory: 'web',
      environment: 'web',
      name: '@flighthq/web',
      sources: { 'index.ts': goodModule },
    };
    const run = checkRun([web]);

    const named = validateCompilerCommandLineCheckRequest(
      { argv: ['/ws', '--target', 'rust', '--package', '@flighthq/web'] },
      run.capabilities,
    );
    const withEnvironment = validateCompilerCommandLineCheckRequest(
      { argv: ['/ws', '--target', 'rust', '--package', '@flighthq/web', '--environment', 'web'] },
      run.capabilities,
    );

    expect(named.exitCode).toBe(2);
    expect(run.err.join('')).toContain('requires the web environment');
    expect(withEnvironment.exitCode).toBe(0);
    expect(checkOutcome(withEnvironment).eligiblePackageNames).toEqual(['@flighthq/web']);
  });

  it('writes the report it was asked for and keeps the verdict on the stream', () => {
    const run = checkRun([core]);

    const result = validateCompilerCommandLineCheckRequest(
      { argv: ['/ws', '--target', 'rust', '--format', 'json', '--report', '/ws/check-report.json'] },
      run.capabilities,
    );

    expect(result.exitCode).toBe(1);
    expect(run.reports.get('/ws/check-report.json')).toContain('"schema": "flight-compiler-check-run/1"');
    expect(run.reports.get('/ws/check-report.json')).toContain('"schema": "flight-compiler-check-report/1"');
    expect(run.out.join('')).toContain('1 gating');
    expect(run.out.join('')).not.toContain('"schema"');
  });

  it('renders the same JSON for the same run, under one identity', () => {
    const first = checkRun([core]);
    const second = checkRun([core]);
    const argv = ['/ws', '--target', 'rust', '--format', 'json'];

    const rendered = validateCompilerCommandLineCheckRequest({ argv }, first.capabilities);
    validateCompilerCommandLineCheckRequest({ argv }, second.capabilities);

    expect(first.out.join('')).toBe(second.out.join(''));
    expect(rendered.exitCode).toBe(1);
    expect(JSON.parse(first.out.join('')) as unknown).toMatchObject({
      exitCode: 1,
      schema: 'flight-compiler-check-run/1',
    });
  });

  it('records the provenance its caller supplies rather than the run own unversioned default', () => {
    const provenance: CompilerPackageCheckProvenance = {
      compiler: { name: 'flight-compiler', revision: 'abc123' },
      target: { name: 'flight-cpp', revision: 'def456' },
      upstream: { name: 'flight', revision: 'ghi789' },
    };
    const run = checkRun([quiet], { provenance });

    const result = validateCompilerCommandLineCheckRequest({ argv: ['/ws', '--target', 'cpp'] }, run.capabilities);

    expect(checkOutcome(result).report.provenance).toEqual(provenance);
    expect(run.out.join('')).toContain('compiler=flight-compiler@abc123');
  });

  it('records the workspace revision its caller could read, and says unversioned when it could not', () => {
    const read = checkRun([quiet], { upstreamRevision: 'a'.repeat(40) });
    const absent = checkRun([quiet], { upstreamRevision: undefined });
    const argv = ['/ws', '--target', 'rust'];

    const recorded = validateCompilerCommandLineCheckRequest({ argv }, read.capabilities);
    const unversioned = validateCompilerCommandLineCheckRequest({ argv }, absent.capabilities);

    expect(checkOutcome(recorded).report.provenance.upstream).toEqual({
      name: 'workspace',
      revision: 'a'.repeat(40),
    });
    expect(checkOutcome(unversioned).report.provenance.upstream).toEqual({
      name: 'workspace',
      revision: 'unversioned',
    });
  });

  it('treats a directory that holds no workspace as an invocation failure rather than a clean run', () => {
    const run = checkRun([quiet]);

    const result = validateCompilerCommandLineCheckRequest(
      { argv: ['/ws/absent', '--target', 'rust'] },
      run.capabilities,
    );

    expect(result.exitCode).toBe(2);
    expect(run.err.join('')).toContain('packages directory does not exist');
  });

  it('refuses an incomplete invocation with the usage rather than a stack', () => {
    const run = checkRun([quiet]);

    const result = validateCompilerCommandLineCheckRequest({ argv: ['--target', 'rust'] }, run.capabilities);

    expect(result.exitCode).toBe(2);
    expect(run.err.join('')).toContain('A workspace directory is required');
    expect(run.err.join('')).toContain(getCompilerCommandLineCheckUsage());
  });
});

function goodModule(): string {
  return 'export function doubled(value: number): number { return value * 2; }';
}

function checkOutcome(result: Readonly<CompilerCommandLineCheckResult>): Readonly<CompilerCommandLineCheckOutcome> {
  if (isCompilerCommandLineCheckRefusal(result)) throw new Error(`Expected an outcome, got ${result.reason}`);
  return result;
}

interface CheckPackage {
  readonly dependencies?: readonly string[] | undefined;
  readonly directory: string;
  readonly environment?: 'node' | 'web' | undefined;
  readonly name: string;
  readonly sources: Readonly<Record<string, string>>;
}

function checkRun(
  packages: readonly CheckPackage[],
  options: Readonly<{
    baseline?: string | undefined;
    provenance?: CompilerPackageCheckProvenance | undefined;
    upstreamRevision?: string | undefined;
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
  const provenance = options.provenance;
  return {
    capabilities: {
      readBaseline: (file) => (file === '/ws/check.baseline' ? options.baseline : undefined),
      readUpstreamRevision: () => options.upstreamRevision,
      ...(provenance === undefined ? {} : { readProvenance: () => provenance }),
      workspaceSource: createMemoryWorkspaceSource(checkWorkspaceFiles(packages)),
      write: (text) => out.push(text),
      writeError: (text) => err.push(text),
      writeReportFile: (file, contents) => reports.set(file, contents),
    },
    err,
    out,
    reports,
  };
}

// A workspace as the inventory reads it: package manifests with the root export lane a real package
// declares, and the sources behind it. The export target is `dist`, because that is the shape the export
// reader resolves back to `src`, not a shorthand this fixture is allowed to invent.
function checkWorkspaceFiles(packages: readonly CheckPackage[]): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of packages) {
    const root = `/ws/packages/${entry.directory}`;
    files[`${root}/package.json`] = JSON.stringify({
      name: entry.name,
      version: '1.0.0',
      exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
      ...(entry.dependencies === undefined
        ? {}
        : { dependencies: Object.fromEntries(entry.dependencies.map((name) => [name, '1.0.0'])) }),
      ...(entry.environment === undefined ? {} : { flight: { environment: entry.environment } }),
    });
    for (const [moduleName, contents] of Object.entries(entry.sources)) {
      files[`${root}/src/${moduleName}`] = contents;
    }
  }
  return files;
}

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

describe('isCompilerCommandLineCheckRefusal', () => {
  it('separates a run that happened from an invocation that could not be carried out', () => {
    const run = checkRun([{ directory: 'core', name: '@flighthq/core', sources: { 'index.ts': goodModule() } }]);

    const outcome = validateCompilerCommandLineCheckRequest({ argv: ['/ws', '--target', 'rust'] }, run.capabilities);
    const refusal = validateCompilerCommandLineCheckRequest({ argv: [] }, run.capabilities);

    expect(isCompilerCommandLineCheckRefusal(outcome)).toBe(false);
    expect(isCompilerCommandLineCheckRefusal(refusal)).toBe(true);
    expect(refusal).toMatchObject({ exitCode: 2 });
  });
});

describe('createCompilerCommandLineCheckReport', () => {
  const refusedIdentity =
    'flight-compiler-check-finding/1:["@flighthq/core","packages/core/src/bad.ts","Bad","emission","unsupported-ir",null]';
  const outcome = (): Readonly<CompilerCommandLineCheckOutcome> => {
    const report = createCompilerPackageCheckReport(
      {
        backend: 'rust',
        modules: [
          {
            module: { name: 'Bad', packageName: '@flighthq/core', source: 'packages/core/src/bad.ts' },
            refusals: [{ code: 'unsupported-ir', message: 'zebra reason', stage: 'emission' }],
            status: 'refused' as const,
          },
        ],
        packages: [{ dependencies: [], name: '@flighthq/core', root: 'packages/core' }],
        schema: 'flight-compiler-package-report/1' as const,
        typescript: {
          checkerMode: 'full' as const,
          compilerOptions: {},
          schema: 'flight-typescript/1' as const,
          typescriptVersion: '5.9.3',
        },
      } as never,
      {
        provenance: {
          compiler: { name: 'c', revision: '1' },
          target: { name: 't', revision: '1' },
          upstream: { name: 'u', revision: '1' },
        },
      },
    );
    const comparison: CompilerPackageCheckComparison = {
      introduced: report.directFindings,
      resolvedFindingIdentities: [],
      schema: 'flight-compiler-check-comparison/1',
      unchanged: [],
    };
    const policyResult = createCompilerPackageCheckPolicyResult(comparison, createCompilerPackageCheckPolicyStrict());
    return {
      comparison,
      eligiblePackageNames: ['@flighthq/core'],
      exitCode: policyResult.passed ? 0 : 1,
      policyResult,
      report,
    };
  };

  it('renders the report the check package produced and the verdict the invocation reached', () => {
    const rendered = createCompilerCommandLineCheckReport(outcome());

    expect(rendered).toContain('zebra reason');
    expect(rendered).toContain('1 gating');
    expect(rendered.indexOf('Flight compiler check')).toBeLessThan(rendered.indexOf('1 gating'));
    expect(outcome().report.directFindings[0]?.identity).toBe(refusedIdentity);
  });

  it('renders a refusal it could not carry out as the reason, in either format', () => {
    const refusal = { exitCode: 2 as const, reason: 'Baseline /ws/check.baseline could not be read' };

    expect(createCompilerCommandLineCheckReport(refusal)).toContain('could not be read');
    expect(JSON.parse(createCompilerCommandLineCheckReport(refusal, 'json'))).toMatchObject({
      exitCode: 2,
      schema: 'flight-compiler-check-run/1',
    });
  });
});
