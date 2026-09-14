import { describe, expect, it } from 'vitest';

import { createCompilerHaxeRuntimeAbiManifest } from './haxeRuntimeAbiManifest.js';

describe('createCompilerHaxeRuntimeAbiManifest', () => {
  it('publishes the complete versioned Haxe runtime ABI surface', () => {
    const manifest = createCompilerHaxeRuntimeAbiManifest();

    expect(manifest).toMatchObject({
      ambientMembers: { schema: 'flight-haxe-ambient-member-bindings/1' },
      constructors: { contract: 'flight-runtime-constructor-abi/1' },
      externalSymbols: {
        contract: 'flight-runtime-contract/2',
        schema: 'flight-haxe-runtime-external-symbol-bindings/1',
      },
      intrinsics: { schema: 'flight-haxe-runtime-intrinsics/1' },
      schema: 'flight-haxe-runtime-abi/2',
      tasks: { contract: 'flight-runtime-task-capability-abi/1' },
    });
    expect(manifest.ambientMembers.bindings).toContainEqual({
      binding: { kind: 'runtimeCall', targetName: '_TypedArray.copyWithin' },
      receiver: 'typedArray',
      sourceMember: 'copyWithin',
    });
    expect(manifest.externalSymbols.bindings).toContainEqual({
      capability: 'async-iterable',
      externalSymbol: { sourceName: 'AsyncIterable', space: 'type' },
      kind: 'runtime',
      targetName: '_AsyncIterable',
    });
    expect(manifest.intrinsics.requirements).toContainEqual({
      capability: 'array',
      members: ['pushMany'],
      targetName: '_ArrayTools',
    });
    expect(manifest.intrinsics.requirements).toContainEqual({
      capability: 'javascript-semantics',
      members: expect.arrayContaining(['getProperty', 'strictEqual', 'truthy', 'typeOf']),
      targetName: '_Js',
    });
    expect(manifest.externalSymbols.bindings).toContainEqual({
      capability: 'async-iterable',
      externalSymbol: { sourceName: 'AsyncIterable', space: 'value' },
      kind: 'runtime',
      members: [{ sourceMember: 'forEachAsync', targetName: '_AsyncIterable.forEachAsync' }],
      targetName: '_AsyncIterable',
    });
  });

  it('returns independent manifest values', () => {
    const first = createCompilerHaxeRuntimeAbiManifest();
    const second = createCompilerHaxeRuntimeAbiManifest();

    (first.ambientMembers.bindings as unknown[]).pop();
    expect(second.ambientMembers.bindings.length).toBeGreaterThan(first.ambientMembers.bindings.length);
  });
});
