import type {
  CompilerRuntimeAbiManifest,
  CompilerRuntimeExternalMemberBinding,
  CompilerRustRuntimeAbiManifest,
} from './compilerRuntimeContract.js';

describe('CompilerRuntimeExternalMemberBinding', () => {
  it('carries optional exact call-result evidence independently from its target spelling', () => {
    const binding = {
      callResultType: 'flight::Symbol',
      sourceMember: 'for',
      targetName: 'flight::Symbol::for_key',
    } satisfies CompilerRuntimeExternalMemberBinding;

    expect(binding).toEqual({
      callResultType: 'flight::Symbol',
      sourceMember: 'for',
      targetName: 'flight::Symbol::for_key',
    });
    expectTypeOf(binding).toMatchTypeOf<CompilerRuntimeExternalMemberBinding>();
  });
});

describe('CompilerRuntimeAbiManifest', () => {
  it('distinguishes the versioned Rust manifest and its representation decisions', () => {
    const manifest = {
      ambientMembers: { bindings: [], schema: 'flight-rust-ambient-member-bindings/1' },
      constructors: { constructors: [], contract: 'flight-runtime-constructor-abi/1' },
      externalSymbols: {
        bindings: [],
        contract: 'flight-runtime-contract/2',
        schema: 'flight-rust-runtime-external-symbol-bindings/1',
      },
      representation: {
        nullability: { nonNull: 'direct', nullableTargetName: 'Option' },
        ownership: { nonCopyReuse: 'clone', runtimeWrapperCarrier: 'owned', temporaryAccess: 'borrow' },
        schema: 'flight-rust-runtime-representation/1',
      },
      requirements: {
        requirements: [],
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
        unsupportedCapabilities: [],
      },
      schema: 'flight-rust-runtime-abi/2',
    } as const satisfies CompilerRustRuntimeAbiManifest;

    expect(manifest.schema).toBe('flight-rust-runtime-abi/2');
    expectTypeOf(manifest).toMatchTypeOf<CompilerRuntimeAbiManifest>();
  });
});
