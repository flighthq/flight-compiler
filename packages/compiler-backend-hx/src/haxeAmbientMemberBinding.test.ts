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

  it('answers nothing for a member with no agreed spelling, so emission refuses rather than guesses', () => {
    // `replace` is deliberately unbound: the source replaces the first occurrence and Haxe's replaces
    // every one, which is a difference that compiles.
    expect(getCompilerHaxeAmbientMemberBinding({ name: 'replace', receiver: 'string' })).toBeUndefined();
    expect(getCompilerHaxeAmbientMemberBinding({ name: 'sort', receiver: 'array' })).toBeUndefined();
    expect(getCompilerHaxeAmbientMemberBinding({ name: 'toFixed', receiver: 'number' })).toBeUndefined();
    expect(getCompilerHaxeAmbientMemberBinding({ name: 'length', receiver: 'number' })).toBeUndefined();
  });
});
