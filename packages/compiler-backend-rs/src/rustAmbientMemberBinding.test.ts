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

  it('borrows the key argument for map and set deletion', () => {
    expect(getCompilerRustAmbientMemberBinding({ name: 'delete', receiver: 'map' })).toEqual({
      kind: 'borrowedMethod',
      targetName: 'remove',
    });
    expect(getCompilerRustAmbientMemberBinding({ name: 'delete', receiver: 'set' })).toEqual({
      kind: 'borrowedMethod',
      targetName: 'remove',
    });
  });

  it('spells string indexOf as a sentinel search through find', () => {
    expect(getCompilerRustAmbientMemberBinding({ name: 'indexOf', receiver: 'string' })).toEqual({
      kind: 'sentinelSearch',
      targetName: 'find',
    });
    expect(getCompilerRustAmbientMemberBinding({ name: 'lastIndexOf', receiver: 'string' })).toEqual({
      kind: 'sentinelSearch',
      targetName: 'rfind',
    });
  });

  it('spells array indexOf as a position search through iter', () => {
    expect(getCompilerRustAmbientMemberBinding({ name: 'indexOf', receiver: 'array' })).toEqual({
      kind: 'positionSearch',
      targetName: 'position',
    });
    expect(getCompilerRustAmbientMemberBinding({ name: 'lastIndexOf', receiver: 'array' })).toEqual({
      kind: 'positionSearch',
      targetName: 'rposition',
    });
  });

  it('spells split as a collected split iterator', () => {
    expect(getCompilerRustAmbientMemberBinding({ name: 'split', receiver: 'string' })).toEqual({
      kind: 'splitCollect',
      targetName: 'split',
    });
  });

  it('spells array join as a borrowed method call', () => {
    expect(getCompilerRustAmbientMemberBinding({ name: 'join', receiver: 'array' })).toEqual({
      kind: 'borrowedMethod',
      targetName: 'join',
    });
  });

  it('spells map get as an optional lookup that clones the reference', () => {
    expect(getCompilerRustAmbientMemberBinding({ name: 'get', receiver: 'map' })).toEqual({
      kind: 'optionalLookup',
      targetName: 'get',
    });
  });

  it('spells array shift as remove at index zero', () => {
    expect(getCompilerRustAmbientMemberBinding({ name: 'shift', receiver: 'array' })).toEqual({
      kind: 'method',
      leadingArguments: ['0'],
      targetName: 'remove',
    });
  });

  it('spells array unshift as insert at index zero', () => {
    expect(getCompilerRustAmbientMemberBinding({ name: 'unshift', receiver: 'array' })).toEqual({
      kind: 'method',
      leadingArguments: ['0'],
      targetName: 'insert',
    });
  });

  it('spells array concat as extend into a new collection', () => {
    expect(getCompilerRustAmbientMemberBinding({ name: 'concat', receiver: 'array' })).toEqual({
      kind: 'method',
      targetName: 'extend',
    });
  });

  it('answers nothing for a member with no agreed spelling, so emission refuses rather than guesses', () => {
    expect(getCompilerRustAmbientMemberBinding({ name: 'sort', receiver: 'array' })).toBeUndefined();
    expect(getCompilerRustAmbientMemberBinding({ name: 'toFixed', receiver: 'number' })).toBeUndefined();
  });
});
