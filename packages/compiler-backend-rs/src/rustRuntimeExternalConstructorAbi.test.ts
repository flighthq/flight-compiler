import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import ts from 'typescript';

import { isBackendEmissionFailure } from '../../compiler-emission/src/index.js';
import { analyzeCompilerRuntimeExternalConstructorAbiCompleteness } from '../../compiler-runtime-contract/src/index.js';
import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import { emitIrModuleRust } from './rustCompilerBackend.js';
import { createCompilerRuntimeExternalConstructorAbiPlanRust } from './rustRuntimeExternalConstructorAbi.js';
import { getCompilerRuntimeExternalSymbolTargetRust } from './rustRuntimeExternalSymbolBinding.js';

const rustcAvailable = spawnSync('rustc', ['--version'], { stdio: 'ignore' }).status === 0;

function captureBackendEmissionFailure(run: () => unknown) {
  try {
    run();
  } catch (error) {
    if (isBackendEmissionFailure(error)) return error;
    throw error;
  }
  throw new Error('expected Rust emission to refuse and it did not');
}

function compileRustSource(contents: string): void {
  const directory = mkdtempSync(path.join(tmpdir(), 'flight-rust-constructor-'));
  try {
    const subject = path.join(directory, 'subject.rs');
    writeFileSync(subject, contents);
    const result = spawnSync(
      'rustc',
      [
        '--edition',
        '2021',
        '--crate-type=lib',
        '--emit=metadata',
        '-o',
        path.join(directory, 'subject.rmeta'),
        subject,
      ],
      { encoding: 'utf8' },
    );
    if (result.status !== 0) throw new Error(`${result.stdout ?? ''}${result.stderr ?? ''}`.trim());
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

function lower(source: string) {
  const sourceFile = ts.createSourceFile(
    '/flight/packages/runtime/src/constructors.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  return lowerTypeScriptSource(sourceFile, { packageName: '@flighthq/runtime', upstreamDirectory: '/flight' }).module;
}

describe('createCompilerRuntimeExternalConstructorAbiPlanRust', () => {
  it('elects exact fixed arities under the versioned constructor ABI contract', () => {
    const plan = createCompilerRuntimeExternalConstructorAbiPlanRust();

    expect(plan.contract).toBe('flight-runtime-constructor-abi/1');
    expect(plan.constructors).toHaveLength(14);
    expect(plan.constructors).toContainEqual({
      dynamicArguments: false,
      externalSymbol: { sourceName: 'Uint8Array', space: 'value' },
      fixedArgumentCounts: [0, 1, 2, 3],
    });
    expect(plan.constructors).toContainEqual({
      dynamicArguments: false,
      externalSymbol: { sourceName: 'DataView', space: 'value' },
      fixedArgumentCounts: [1, 2, 3],
    });
    expect(plan.constructors).toContainEqual({
      dynamicArguments: false,
      externalSymbol: { sourceName: 'Map', space: 'value' },
      fixedArgumentCounts: [0],
    });
    expect(plan.constructors).toContainEqual({
      dynamicArguments: false,
      externalSymbol: { sourceName: 'Set', space: 'value' },
      fixedArgumentCounts: [0],
    });
    for (const sourceName of ['Date', 'Error', 'RangeError', 'TypeError']) {
      expect(plan.constructors).not.toContainEqual(
        expect.objectContaining({ externalSymbol: { sourceName, space: 'value' } }),
      );
    }
    expect(plan.constructors).not.toContainEqual(
      expect.objectContaining({ externalSymbol: { sourceName: 'Promise', space: 'value' } }),
    );
    expect(
      plan.constructors.every(
        ({ externalSymbol }) =>
          getCompilerRuntimeExternalSymbolTargetRust(externalSymbol.sourceName, externalSymbol.space) !== undefined,
      ),
    ).toBe(true);
  });

  it('accepts only the callable collection forms in constructor ABI completeness', () => {
    const plan = createCompilerRuntimeExternalConstructorAbiPlanRust();
    expect(
      analyzeCompilerRuntimeExternalConstructorAbiCompleteness(
        [
          { externalSymbol: { sourceName: 'Map', space: 'value' }, providedArgumentCount: 0 },
          { externalSymbol: { sourceName: 'Set', space: 'value' }, providedArgumentCount: 0 },
        ],
        plan,
      ),
    ).toMatchObject({ kind: 'complete' });

    expect(
      analyzeCompilerRuntimeExternalConstructorAbiCompleteness(
        [
          { externalSymbol: { sourceName: 'Date', space: 'value' }, providedArgumentCount: 0 },
          { externalSymbol: { sourceName: 'Date', space: 'value' }, providedArgumentCount: 1 },
          { externalSymbol: { sourceName: 'Error', space: 'value' }, providedArgumentCount: 0 },
          { externalSymbol: { sourceName: 'Error', space: 'value' }, providedArgumentCount: 1 },
          { externalSymbol: { sourceName: 'Map', space: 'value' }, providedArgumentCount: 1 },
          { externalSymbol: { sourceName: 'RangeError', space: 'value' }, providedArgumentCount: 1 },
          { externalSymbol: { sourceName: 'Set', space: 'value' }, providedArgumentCount: 1 },
          { externalSymbol: { sourceName: 'TypeError', space: 'value' }, providedArgumentCount: 1 },
        ],
        plan,
      ),
    ).toMatchObject({
      kind: 'incomplete',
      missingExternalConstructors: [
        { externalSymbol: { sourceName: 'Date', space: 'value' }, providedArgumentCount: 0 },
        { externalSymbol: { sourceName: 'Date', space: 'value' }, providedArgumentCount: 1 },
        { externalSymbol: { sourceName: 'Error', space: 'value' }, providedArgumentCount: 0 },
        { externalSymbol: { sourceName: 'Error', space: 'value' }, providedArgumentCount: 1 },
        { externalSymbol: { sourceName: 'Map', space: 'value' }, providedArgumentCount: 1 },
        { externalSymbol: { sourceName: 'RangeError', space: 'value' }, providedArgumentCount: 1 },
        { externalSymbol: { sourceName: 'Set', space: 'value' }, providedArgumentCount: 1 },
        { externalSymbol: { sourceName: 'TypeError', space: 'value' }, providedArgumentCount: 1 },
      ],
    });
  });

  it('emits only zero-argument HashMap and HashSet construction', () => {
    const output = emitIrModuleRust(
      lower(
        `export function createMap(): Map<string, number> { return new Map(); }
         export function createSet(): Set<number> { return new Set(); }`,
      ),
    ).contents;

    expect(output).toContain('return std::collections::HashMap::new();');
    expect(output).toContain('return std::collections::HashSet::new();');
  });

  it('keeps direct typed error throws on the panic path without advertising constructors', () => {
    const output = emitIrModuleRust(
      lower(
        `export function failError(message: string): never { throw new Error(message); }
         export function failRange(message: string): never { throw new RangeError(message); }
         export function failType(message: string): never { throw new TypeError(message); }`,
      ),
    ).contents;

    expect(output.split('panic!("{}", message);')).toHaveLength(4);
    expect(output).not.toContain('Error::new');
  });

  it.each([
    ['Date without arguments', 'export function create(): Date { return new Date(); }', 'Date[value](0)'],
    ['Date with a timestamp', 'export function create(): Date { return new Date(0); }', 'Date[value](1)'],
    ['Date thrown as a value', 'export function fail(): never { throw new Date(0); }', 'Date[value](1)'],
    ['Error as a value', 'export function create(): Error { return new Error("message"); }', 'Error[value](1)'],
    [
      'Error as a value beside a direct throw',
      `export function fail(message: string): never { throw new Error(message); }
       export function create(message: string): Error { return new Error(message); }`,
      'Error[value](1)',
    ],
    [
      'RangeError as a value',
      'export function create(): RangeError { return new RangeError("message"); }',
      'RangeError[value](1)',
    ],
    [
      'TypeError as a value',
      'export function create(): TypeError { return new TypeError("message"); }',
      'TypeError[value](1)',
    ],
    [
      'Map with an iterable',
      'export function create(): Map<string, number> { return new Map([["key", 1]]); }',
      'Map[value](1)',
    ],
    ['Set with an iterable', 'export function create(): Set<number> { return new Set([1]); }', 'Set[value](1)'],
  ])('refuses %s before Rust source emission', (_name, source, missing) => {
    const failure = captureBackendEmissionFailure(() => emitIrModuleRust(lower(source)));

    expect(failure.rule).toBe('rust-runtime-external-constructor-abi-incomplete');
    expect(failure.classification).toBe('target-runtime');
    expect(failure.message).toContain(`missing: ${missing}`);
  });

  it.skipIf(!rustcAvailable)('emits supported collection constructors accepted by rustc', () => {
    const output = emitIrModuleRust(
      lower(
        `export function createMap(): Map<string, number> { return new Map(); }
         export function createSet(): Set<number> { return new Set(); }`,
      ),
    ).contents;

    expect(() => compileRustSource(output)).not.toThrow();
  });

  it('creates independent plan records and nested arity lists', () => {
    const first = createCompilerRuntimeExternalConstructorAbiPlanRust();
    const second = createCompilerRuntimeExternalConstructorAbiPlanRust();

    (first.constructors as unknown[]).pop();
    (first.constructors[0]!.fixedArgumentCounts as number[]).push(1);
    expect(second.constructors).toHaveLength(14);
    expect(second.constructors[0]?.fixedArgumentCounts).toEqual([0]);
  });
});
