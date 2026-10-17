import ts from 'typescript';

import { isBackendEmissionFailure } from '../../compiler-emission/src/index.js';
import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import { createRustCompilerBackend, emitIrModuleRust } from './rustCompilerBackend.js';
import { createCompilerRustRuntimeAbiManifest } from './rustRuntimeAbiManifest.js';

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
      schema: 'flight-rust-runtime-abi/1',
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
  });

  it('serializes deterministically and returns independent nested records', () => {
    const first = createCompilerRustRuntimeAbiManifest();
    const second = createCompilerRustRuntimeAbiManifest();

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    (first.ambientMembers.bindings as unknown[]).pop();
    const firstPromise = first.externalSymbols.bindings.find(
      ({ externalSymbol }) => externalSymbol.sourceName === 'Promise' && externalSymbol.space === 'value',
    );
    if (!firstPromise?.members) throw new Error('expected the first Promise value member binding');
    (firstPromise.members as unknown[]).pop();
    expect(second.ambientMembers.bindings).toHaveLength(82);
    expect(
      second.ambientMembers.bindings.some(
        ({ receiver, sourceMember }) => receiver === 'string' && sourceMember === 'length',
      ),
    ).toBe(false);
    expect(
      second.externalSymbols.bindings.find(
        ({ externalSymbol }) => externalSymbol.sourceName === 'Promise' && externalSymbol.space === 'value',
      )?.members,
    ).toEqual([{ sourceMember: 'resolve', targetName: 'FlightTask::ready' }]);
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

    expect(() =>
      emitIrModuleRust(lower('export function order(values: number[]): number[] { return values.sort(); }')),
    ).toThrow('array member sort has no Rust binding');
  });
});
