import { describe, expect, it } from 'vitest';

import { getCompilerHaxeAmbientMemberBinding } from './haxeAmbientMemberBinding.js';

describe('getCompilerHaxeAmbientMemberBinding', () => {
  it('answers a rename, and a member Haxe keeps somewhere other than the value', () => {
    expect(getCompilerHaxeAmbientMemberBinding({ name: 'length', receiver: 'array' })).toEqual({
      kind: 'property',
      targetName: 'length',
    });
    // `trim` is a `StringTools` function in Haxe, so the receiver becomes its first argument.
    expect(getCompilerHaxeAmbientMemberBinding({ name: 'trim', receiver: 'string' })).toEqual({
      kind: 'staticCall',
      targetPath: 'StringTools.trim',
    });
    // `Lambda.fold` takes its accumulator second where the source takes it first, which is a
    // different shape from a rename and is named as one.
    expect(getCompilerHaxeAmbientMemberBinding({ name: 'reduce', receiver: 'array' })).toEqual({
      kind: 'staticFold',
      targetPath: 'Lambda.fold',
    });
  });

  it('spells string.includes as StringTools.contains because Haxe String has no includes method', () => {
    expect(getCompilerHaxeAmbientMemberBinding({ name: 'includes', receiver: 'string' })).toEqual({
      kind: 'staticCall',
      targetPath: 'StringTools.contains',
    });
  });

  it('spells first-occurrence replace as a runtime helper because Haxe replaces every occurrence', () => {
    expect(getCompilerHaxeAmbientMemberBinding({ name: 'replace', receiver: 'string' })).toEqual({
      kind: 'runtimeCall',
      targetName: '_StringTools.replaceFirst',
    });
  });

  it('routes source-only collection and string semantics through the selected runtime', () => {
    expect(getCompilerHaxeAmbientMemberBinding({ name: 'slice', receiver: 'arrayBuffer' })).toEqual({
      kind: 'runtimeCall',
      targetName: '_ArrayBuffer.slice',
    });
    expect(getCompilerHaxeAmbientMemberBinding({ name: 'sort', receiver: 'array' })).toEqual({
      kind: 'runtimeCall',
      targetName: '_Array.sort',
    });
    expect(getCompilerHaxeAmbientMemberBinding({ name: 'padStart', receiver: 'string' })).toEqual({
      kind: 'runtimeCall',
      targetName: '_StringTools.padStart',
    });
    expect(getCompilerHaxeAmbientMemberBinding({ name: 'slice', receiver: 'string' })).toEqual({
      kind: 'runtimeCall',
      targetName: '_StringTools.slice',
    });
    expect(getCompilerHaxeAmbientMemberBinding({ name: 'repeat', receiver: 'string' })).toEqual({
      kind: 'runtimeCall',
      targetName: '_StringTools.repeat',
    });
    expect(getCompilerHaxeAmbientMemberBinding({ name: 'values', receiver: 'map' })).toEqual({
      kind: 'method',
      targetName: 'values',
    });
    expect(getCompilerHaxeAmbientMemberBinding({ name: 'entries', receiver: 'map' })).toEqual({
      kind: 'method',
      targetName: 'entries',
    });
    expect(getCompilerHaxeAmbientMemberBinding({ name: 'forEach', receiver: 'array' })).toEqual({
      kind: 'staticCall',
      targetPath: 'Lambda.iter',
    });
    expect(getCompilerHaxeAmbientMemberBinding({ name: 'flatMap', receiver: 'array' })).toEqual({
      kind: 'runtimeCall',
      targetName: '_Array.flatMap',
    });
    expect(getCompilerHaxeAmbientMemberBinding({ name: 'entries', receiver: 'array' })).toEqual({
      kind: 'runtimeCall',
      targetName: '_Array.entries',
    });
    expect(getCompilerHaxeAmbientMemberBinding({ name: 'fill', receiver: 'array' })).toEqual({
      kind: 'runtimeCall',
      targetName: '_Array.fill',
    });
    expect(getCompilerHaxeAmbientMemberBinding({ name: 'every', receiver: 'tuple' })).toEqual({
      kind: 'staticCall',
      targetPath: 'Lambda.foreach',
    });
  });

  it('marks index arguments for Int coercion on methods that take Haxe Int', () => {
    expect(getCompilerHaxeAmbientMemberBinding({ name: 'charAt', receiver: 'string' })).toMatchObject({
      intArguments: [0],
    });
    expect(getCompilerHaxeAmbientMemberBinding({ name: 'charCodeAt', receiver: 'string' })).toMatchObject({
      intArguments: [0],
    });
    expect(getCompilerHaxeAmbientMemberBinding({ name: 'substring', receiver: 'string' })).toMatchObject({
      intArguments: [0, 1],
    });
    expect(getCompilerHaxeAmbientMemberBinding({ name: 'indexOf', receiver: 'string' })).toMatchObject({
      intArguments: [1],
    });
  });

  it('keeps the typed-array members supplied by the Haxe runtime wrappers', () => {
    expect(getCompilerHaxeAmbientMemberBinding({ name: 'copyWithin', receiver: 'typedArray' })).toEqual({
      kind: 'runtimeCall',
      targetName: '_TypedArray.copyWithin',
    });
    expect(getCompilerHaxeAmbientMemberBinding({ name: 'length', receiver: 'typedArray' })).toEqual({
      kind: 'property',
      targetName: 'length',
    });
    expect(getCompilerHaxeAmbientMemberBinding({ name: 'slice', receiver: 'typedArray' })).toEqual({
      kind: 'method',
      targetName: 'slice',
    });
    expect(getCompilerHaxeAmbientMemberBinding({ name: 'subarray', receiver: 'typedArray' })).toEqual({
      kind: 'method',
      targetName: 'subarray',
    });
    expect(getCompilerHaxeAmbientMemberBinding({ name: 'set', receiver: 'typedArray' })).toEqual({
      intArguments: [1],
      kind: 'method',
      targetName: 'set',
    });
    expect(getCompilerHaxeAmbientMemberBinding({ name: 'byteLength', receiver: 'typedArray' })).toEqual({
      kind: 'property',
      targetName: 'byteLength',
    });
    expect(getCompilerHaxeAmbientMemberBinding({ name: 'buffer', receiver: 'typedArray' })).toEqual({
      kind: 'property',
      targetName: 'buffer',
    });
  });

  it('binds portable DataView, RegExp, task, and string wrapper members explicitly', () => {
    expect(getCompilerHaxeAmbientMemberBinding({ name: 'getUint16', receiver: 'dataView' })).toEqual({
      intArguments: [0],
      kind: 'method',
      targetName: 'getUint16',
    });
    expect(getCompilerHaxeAmbientMemberBinding({ name: 'setFloat32', receiver: 'dataView' })).toEqual({
      intArguments: [0],
      kind: 'method',
      targetName: 'setFloat32',
    });
    expect(getCompilerHaxeAmbientMemberBinding({ name: 'exec', receiver: 'regexp' })).toEqual({
      kind: 'method',
      targetName: 'exec',
    });
    expect(getCompilerHaxeAmbientMemberBinding({ name: 'then', receiver: 'task' })).toEqual({
      kind: 'method',
      targetName: 'then',
    });
    expect(getCompilerHaxeAmbientMemberBinding({ name: 'finally', receiver: 'task' })).toEqual({
      kind: 'runtimeCall',
      targetName: '_Promise.finallyTask',
    });
    expect(getCompilerHaxeAmbientMemberBinding({ name: 'padEnd', receiver: 'string' })).toEqual({
      kind: 'runtimeCall',
      targetName: '_StringTools.padEnd',
    });
    expect(getCompilerHaxeAmbientMemberBinding({ name: 'trimEnd', receiver: 'string' })).toEqual({
      kind: 'runtimeCall',
      targetName: '_StringTools.trimEnd',
    });
  });

  it('answers nothing for a member with no agreed spelling, so emission refuses rather than guesses', () => {
    expect(getCompilerHaxeAmbientMemberBinding({ name: 'at', receiver: 'array' })).toBeUndefined();
    expect(getCompilerHaxeAmbientMemberBinding({ name: 'toPrecision', receiver: 'number' })).toBeUndefined();
    expect(getCompilerHaxeAmbientMemberBinding({ name: 'length', receiver: 'number' })).toBeUndefined();
  });
});
