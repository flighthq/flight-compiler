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
  });

  it('answers nothing for a member with no agreed spelling, so emission refuses rather than guesses', () => {
    // `replace` is deliberately unbound: the source replaces the first occurrence and Haxe's replaces
    // every one, which is a difference that compiles.
    expect(getCompilerHaxeAmbientMemberBinding({ name: 'replace', receiver: 'string' })).toBeUndefined();
    expect(getCompilerHaxeAmbientMemberBinding({ name: 'reduce', receiver: 'array' })).toBeUndefined();
    expect(getCompilerHaxeAmbientMemberBinding({ name: 'length', receiver: 'number' })).toBeUndefined();
  });
});
