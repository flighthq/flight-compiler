import { describe, expect, it } from 'vitest';

import { getCompilerRustAmbientMemberBinding } from './rustAmbientMemberBinding.js';

describe('getCompilerRustAmbientMemberBinding', () => {
  it('answers the shape a member reaches its result through, not only its name', () => {
    // Rust counts in `usize`, so length is a call the emitter casts back into the numeric domain.
    expect(getCompilerRustAmbientMemberBinding({ name: 'length', receiver: 'array' })).toEqual({
      kind: 'countingMethod',
      targetName: 'len',
    });
    // `map` is an iterator adaptor whose result has to be collected back into a collection.
    expect(getCompilerRustAmbientMemberBinding({ name: 'map', receiver: 'array' })).toEqual({
      collect: true,
      kind: 'iterator',
      targetName: 'map',
    });
    // `filter` hands its closure a reference where `map` hands it the element.
    expect(getCompilerRustAmbientMemberBinding({ name: 'filter', receiver: 'array' })).toMatchObject({
      borrowsElement: true,
    });
    // The source replaces the first occurrence, which is `replacen` with a count of one.
    expect(getCompilerRustAmbientMemberBinding({ name: 'replace', receiver: 'string' })).toMatchObject({
      targetName: 'replacen',
      trailingArguments: ['1'],
    });
  });

  it('spells string.includes as a borrowed contains call', () => {
    expect(getCompilerRustAmbientMemberBinding({ name: 'includes', receiver: 'string' })).toEqual({
      kind: 'borrowedMethod',
      targetName: 'contains',
    });
  });

  it('answers nothing for a member with no agreed spelling, so emission refuses rather than guesses', () => {
    expect(getCompilerRustAmbientMemberBinding({ name: 'sort', receiver: 'array' })).toBeUndefined();
    expect(getCompilerRustAmbientMemberBinding({ name: 'split', receiver: 'string' })).toBeUndefined();
    expect(getCompilerRustAmbientMemberBinding({ name: 'toFixed', receiver: 'number' })).toBeUndefined();
  });
});
