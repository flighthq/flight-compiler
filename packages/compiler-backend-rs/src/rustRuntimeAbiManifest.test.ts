import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

import { isBackendEmissionFailure } from '../../compiler-emission/src/index.js';
import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import type { CompilerRustRuntimeAbiManifest } from '../../compiler-types/src/index.js';
import { createRustCompilerBackend, emitIrModuleRust } from './rustCompilerBackend.js';
import {
  assertCompilerRustRuntimeAbiManifestComplete,
  createCompilerRustRuntimeAbiManifest,
} from './rustRuntimeAbiManifest.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
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

function lower(source: string) {
  const sourceFile = ts.createSourceFile('/flight/packages/runtime/src/value.ts', source, ts.ScriptTarget.Latest, true);
  return lowerTypeScriptSource(sourceFile, { packageName: '@flighthq/runtime', upstreamDirectory: '/flight' }).module;
}

function compileRustSourceAgainstRuntime(contents: string): void {
  const directory = mkdtempSync(path.join(tmpdir(), 'flight-rust-runtime-abi-'));
  try {
    const runtime = path.join(directory, 'libflight_runtime.rlib');
    const runtimeBuild = spawnSync(
      'rustc',
      [
        '--edition',
        '2021',
        '--crate-name',
        'flight_runtime',
        '--crate-type=lib',
        '-o',
        runtime,
        path.join(repositoryRoot, 'golden/support/rust/flight_runtime.rs'),
      ],
      { encoding: 'utf8' },
    );
    if (runtimeBuild.status !== 0) {
      throw new Error(`${runtimeBuild.stdout ?? ''}${runtimeBuild.stderr ?? ''}`.trim());
    }
    const subject = path.join(directory, 'subject.rs');
    writeFileSync(subject, contents);
    const subjectBuild = spawnSync(
      'rustc',
      [
        '--edition',
        '2021',
        '--crate-type=lib',
        '--emit=metadata',
        '--extern',
        `flight_runtime=${runtime}`,
        '-o',
        path.join(directory, 'subject.rmeta'),
        subject,
      ],
      { encoding: 'utf8' },
    );
    if (subjectBuild.status !== 0) {
      throw new Error(`${subjectBuild.stdout ?? ''}${subjectBuild.stderr ?? ''}`.trim());
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

function isDeeplyFrozen(value: unknown, seen: WeakSet<object>): boolean {
  if (!value || typeof value !== 'object' || seen.has(value)) return true;
  seen.add(value);
  return Object.isFrozen(value) && Object.values(value).every((child) => isDeeplyFrozen(child, seen));
}

describe('assertCompilerRustRuntimeAbiManifestComplete', () => {
  it('fails with a stable target-runtime rule when one emitted helper requirement is absent', () => {
    const module = lower('export const value = 1;');
    const manifest = createCompilerRustRuntimeAbiManifest();
    const incomplete: CompilerRustRuntimeAbiManifest = {
      ...manifest,
      requirements: {
        ...manifest.requirements,
        requirements: manifest.requirements.requirements.filter(
          (requirement) => !(requirement.kind === 'function' && requirement.targetName === 'repeat_text'),
        ),
      },
    };

    const failure = captureBackendEmissionFailure(() =>
      assertCompilerRustRuntimeAbiManifestComplete(module, incomplete),
    );
    expect(failure.classification).toBe('target-runtime');
    expect(failure.rule).toBe('rust-runtime-abi-requirement-incomplete');
    expect(failure.message).toContain('missing function::repeat_text');
  });
});

describe('createCompilerRustRuntimeAbiManifest', () => {
  it('publishes the versioned compiler-owned Rust runtime surface', () => {
    const manifest = createCompilerRustRuntimeAbiManifest();

    expect(manifest).toMatchObject({
      ambientMembers: { schema: 'flight-rust-ambient-member-bindings/1' },
      constructors: { contract: 'flight-runtime-constructor-abi/1' },
      externalSymbols: {
        contract: 'flight-runtime-contract/2',
        schema: 'flight-rust-runtime-external-symbol-bindings/1',
      },
      representation: {
        nullability: { nonNull: 'direct', nullableTargetName: 'Option' },
        ownership: { nonCopyReuse: 'clone', runtimeWrapperCarrier: 'owned', temporaryAccess: 'borrow' },
        schema: 'flight-rust-runtime-representation/1',
      },
      requirements: {
        schema: 'flight-rust-runtime-requirements/1',
        tasks: {
          awaitBoundary: {
            cloneTrait: 'Clone',
            futureTrait: 'Future',
            repeatedAwait: 'clone-before-await',
          },
          readyMember: 'ready',
          schema: 'flight-rust-runtime-task-requirements/1',
          settlement: {
            rejectionCarrier: 'String',
            result: 'Result<T, String>',
            settleMember: 'settle',
            unhandledRejection: 'panic',
          },
          taskType: 'FlightTask',
        },
      },
      schema: 'flight-rust-runtime-abi/2',
    });
    expect(manifest.externalSymbols.bindings).toContainEqual({
      capability: 'task',
      externalSymbol: { sourceName: 'Promise', space: 'value' },
      kind: 'runtime',
      members: [{ sourceMember: 'resolve', targetName: 'FlightTask::ready' }],
      targetName: 'FlightTask',
    });
    expect(manifest.ambientMembers.bindings).toContainEqual({
      binding: { kind: 'runtimeMethod', targetName: 'repeat_text' },
      receiver: 'string',
      sourceMember: 'repeat',
    });
    expect(manifest.requirements.requirements).toEqual(
      expect.arrayContaining([
        { kind: 'member', memberName: 'get_float32', targetName: 'FlightDataView' },
        { kind: 'member', memberName: 'get_index', targetName: 'FlightUint8Array' },
        { kind: 'member', memberName: 'ready', targetName: 'FlightTask' },
        { kind: 'member', memberName: 'settle', targetName: 'FlightTask' },
      ]),
    );
    expect(
      manifest.requirements.requirements.flatMap((requirement) =>
        requirement.kind === 'function' ? [requirement.targetName] : [],
      ),
    ).toEqual(['flight_runtime::round', 'repeat_text']);
    expect(
      manifest.requirements.requirements.flatMap((requirement) =>
        requirement.kind === 'type' ? [requirement.targetName] : [],
      ),
    ).toEqual([
      'FlightArrayBuffer',
      'FlightDataView',
      'FlightDate',
      'FlightFloat32Array',
      'FlightFloat64Array',
      'FlightInt16Array',
      'FlightInt32Array',
      'FlightInt8Array',
      'FlightSymbol',
      'FlightTask',
      'FlightUint16Array',
      'FlightUint32Array',
      'FlightUint8Array',
      'FlightUint8ClampedArray',
      'OpaqueHostValue',
    ]);
    expect([
      ...new Set(
        manifest.requirements.requirements.flatMap((requirement) =>
          requirement.kind === 'member' ? [requirement.targetName] : [],
        ),
      ),
    ]).toEqual([
      'FlightArrayBuffer',
      'FlightDataView',
      'FlightDate',
      'FlightFloat32Array',
      'FlightFloat64Array',
      'FlightInt16Array',
      'FlightInt32Array',
      'FlightInt8Array',
      'FlightTask',
      'FlightUint16Array',
      'FlightUint32Array',
      'FlightUint8Array',
      'FlightUint8ClampedArray',
    ]);
    expect(
      manifest.requirements.requirements.flatMap((requirement) =>
        requirement.kind === 'trait' ? [[requirement.targetName, requirement.traitName]] : [],
      ),
    ).toEqual([
      ['FlightTask', 'Clone'],
      ['FlightTask', 'Future'],
    ]);
    expect(manifest.requirements.unsupportedCapabilities).toEqual([
      {
        capability: 'typed-error-carrier',
        rule: 'rust-runtime-error-carrier-incomplete',
        subjects: ['Error', 'RangeError', 'TypeError'],
      },
      {
        capability: 'utf16-code-unit-index',
        rule: 'rust-string-utf16-index-unrepresented',
        subjects: ['string.charAt', 'string.charCodeAt'],
      },
      {
        capability: 'utf16-code-unit-length',
        rule: 'rust-string-utf16-length-unrepresented',
        subjects: ['string.length'],
      },
      {
        capability: 'utf16-code-unit-range',
        rule: 'rust-string-utf16-range-unrepresented',
        subjects: ['string.slice', 'string.substring'],
      },
    ]);
  });

  it('serializes deterministically and returns independent deeply frozen records', () => {
    const first = createCompilerRustRuntimeAbiManifest();
    const second = createCompilerRustRuntimeAbiManifest();

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first).not.toBe(second);
    expect(first.requirements).not.toBe(second.requirements);
    expect(isDeeplyFrozen(first, new WeakSet())).toBe(true);
    expect(isDeeplyFrozen(second, new WeakSet())).toBe(true);
    expect(second.ambientMembers.bindings).toHaveLength(81);
    expect(
      second.ambientMembers.bindings.some(
        ({ receiver, sourceMember }) => receiver === 'string' && sourceMember === 'length',
      ),
    ).toBe(false);
    expect(
      second.ambientMembers.bindings.some(
        ({ receiver, sourceMember }) => receiver === 'array' && sourceMember === 'shift',
      ),
    ).toBe(false);
  });

  it('is exposed by the backend and refuses runtime APIs absent from the manifest', () => {
    const backendManifest = createRustCompilerBackend().runtimeAbi?.();
    expect(backendManifest).toEqual(createCompilerRustRuntimeAbiManifest());

    const unboundTaskMember = captureBackendEmissionFailure(() =>
      emitIrModuleRust(
        lower('export function create(): Promise<number[]> { return Promise.all([Promise.resolve(1)]); }'),
      ),
    );
    expect(unboundTaskMember.rule).toBe('rust-runtime-external-member-binding-incomplete');
    expect(unboundTaskMember.classification).toBe('target-runtime');

    const unboundConstructor = captureBackendEmissionFailure(() =>
      emitIrModuleRust(lower('export function create(): number[] { return new Array<number>(3); }')),
    );
    expect(unboundConstructor.rule).toBe('rust-runtime-external-constructor-abi-incomplete');
    expect(unboundConstructor.classification).toBe('target-runtime');

    const unboundSymbol = captureBackendEmissionFailure(() =>
      emitIrModuleRust(
        lower(
          'export function view(bytes: Uint8Array<SharedArrayBuffer>): Uint8Array<SharedArrayBuffer> { return bytes.subarray(1); }',
        ),
      ),
    );
    expect(unboundSymbol.rule).toBe('rust-runtime-external-symbol-binding-incomplete');
    expect(unboundSymbol.classification).toBe('target-runtime');

    const defaultSort = captureBackendEmissionFailure(() =>
      emitIrModuleRust(lower('export function order(values: number[]): number[] { return values.sort(); }')),
    );
    expect(defaultSort.rule).toBe('rust-array-sort-default-order-unrepresented');
    expect(defaultSort.classification).toBe('target-runtime');
  });

  it.each(['Error', 'RangeError', 'TypeError'])('keeps typed ambient %s an explicit unsupported capability', (name) => {
    const failure = captureBackendEmissionFailure(() =>
      emitIrModuleRust(lower(`export function message(error: ${name}): string { return error.message; }`)),
    );

    expect(failure.classification).toBe('target-runtime');
    expect(failure.rule).toBe('rust-runtime-error-carrier-incomplete');
  });

  it.skipIf(!rustcAvailable)('compiles one native task and helper source against the compiler-owned runtime', () => {
    const output = emitIrModuleRust(
      lower(
        `export async function render(value: number, text: string): Promise<string> {
           const task: Promise<number> = Promise.resolve(Math.round(value));
           return text.repeat(await task);
         }`,
      ),
    ).contents;

    expect(output).toContain('FlightTask::ready(flight_runtime::round(value))');
    expect(output).toContain('repeat_text(&text, task.await)');
    expect(() => compileRustSourceAgainstRuntime(output)).not.toThrow();
  });
});
