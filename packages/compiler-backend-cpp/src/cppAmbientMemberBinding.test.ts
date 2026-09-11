import { describe, expect, it } from 'vitest';

import { getCompilerCppAmbientMemberBinding } from './cppAmbientMemberBinding.js';

describe('getCompilerCppAmbientMemberBinding', () => {
  it('maps array methods to their C++ standard library equivalents', () => {
    expect(getCompilerCppAmbientMemberBinding({ name: 'push', receiver: 'array' })).toEqual({
      kind: 'method',
      targetName: 'push_back',
    });
    expect(getCompilerCppAmbientMemberBinding({ name: 'pop', receiver: 'array' })).toEqual({
      kind: 'method',
      targetName: 'pop_back',
    });
  });

  it('maps length to a size method that the emitter casts back to double', () => {
    expect(getCompilerCppAmbientMemberBinding({ name: 'length', receiver: 'array' })).toEqual({
      kind: 'sizeMethod',
      targetName: 'size',
    });
    expect(getCompilerCppAmbientMemberBinding({ name: 'length', receiver: 'string' })).toEqual({
      kind: 'sizeMethod',
      targetName: 'size',
    });
  });

  it('maps higher-order array operations to C++ algorithm library calls', () => {
    expect(getCompilerCppAmbientMemberBinding({ name: 'map', receiver: 'array' })).toEqual({
      algorithm: 'std::transform',
      kind: 'algorithm',
      targetName: 'transform',
    });
    expect(getCompilerCppAmbientMemberBinding({ name: 'filter', receiver: 'array' })).toEqual({
      algorithm: 'std::copy_if',
      kind: 'algorithm',
      targetName: 'copy_if',
    });
    expect(getCompilerCppAmbientMemberBinding({ name: 'some', receiver: 'array' })).toEqual({
      algorithm: 'std::any_of',
      kind: 'algorithm',
      targetName: 'any_of',
    });
  });

  it('maps string membership tests to C++ method names', () => {
    expect(getCompilerCppAmbientMemberBinding({ name: 'includes', receiver: 'string' })).toEqual({
      kind: 'method',
      targetName: 'contains',
    });
    expect(getCompilerCppAmbientMemberBinding({ name: 'startsWith', receiver: 'string' })).toEqual({
      kind: 'method',
      targetName: 'starts_with',
    });
  });

  it('maps map and set operations to their unordered container equivalents', () => {
    expect(getCompilerCppAmbientMemberBinding({ name: 'get', receiver: 'map' })).toEqual({
      kind: 'method',
      targetName: 'at',
    });
    expect(getCompilerCppAmbientMemberBinding({ name: 'set', receiver: 'map' })).toEqual({
      kind: 'method',
      targetName: 'insert_or_assign',
    });
    expect(getCompilerCppAmbientMemberBinding({ name: 'add', receiver: 'set' })).toEqual({
      kind: 'method',
      targetName: 'insert',
    });
  });

  it('maps number.toString to std::to_string', () => {
    expect(getCompilerCppAmbientMemberBinding({ name: 'toString', receiver: 'number' })).toEqual({
      kind: 'method',
      targetName: 'to_string',
    });
  });

  it('elects direct semantic-runtime methods for the flight-cpp profile', () => {
    expect(getCompilerCppAmbientMemberBinding({ name: 'map', receiver: 'array' }, 'flight-cpp')).toEqual({
      kind: 'method',
      targetName: 'map',
    });
    expect(getCompilerCppAmbientMemberBinding({ name: 'get', receiver: 'map' }, 'flight-cpp')).toEqual({
      kind: 'method',
      targetName: 'get',
    });
    expect(getCompilerCppAmbientMemberBinding({ name: 'includes', receiver: 'string' }, 'flight-cpp')).toEqual({
      kind: 'method',
      targetName: 'includes',
    });
    expect(getCompilerCppAmbientMemberBinding({ name: 'catch', receiver: 'task' }, 'flight-cpp')).toEqual({
      kind: 'method',
      targetName: 'catch_error',
    });
  });

  it('maps typed-array length in both profiles and runtime methods in the flight-cpp profile', () => {
    for (const runtimeProfile of ['flight-cpp', 'standard-library'] as const) {
      expect(getCompilerCppAmbientMemberBinding({ name: 'length', receiver: 'typedArray' }, runtimeProfile)).toEqual({
        kind: 'sizeMethod',
        targetName: 'size',
      });
    }
    for (const name of ['fill', 'set', 'slice', 'subarray']) {
      expect(getCompilerCppAmbientMemberBinding({ name, receiver: 'typedArray' }, 'flight-cpp')).toEqual({
        kind: 'method',
        targetName: name,
      });
    }
  });

  it('maps binary, text, regexp, and URL members through the semantic runtime', () => {
    expect(getCompilerCppAmbientMemberBinding({ name: 'getFloat64', receiver: 'dataView' }, 'flight-cpp')).toEqual({
      kind: 'method',
      targetName: 'get_float64',
    });
    expect(getCompilerCppAmbientMemberBinding({ name: 'decode', receiver: 'textDecoder' }, 'flight-cpp')).toEqual({
      kind: 'method',
      targetName: 'decode',
    });
    expect(getCompilerCppAmbientMemberBinding({ name: 'exec', receiver: 'regexp' }, 'flight-cpp')).toEqual({
      kind: 'method',
      targetName: 'exec',
    });
    expect(getCompilerCppAmbientMemberBinding({ name: 'protocol', receiver: 'url' }, 'flight-cpp')).toEqual({
      kind: 'property',
      targetName: 'protocol',
    });
    expect(getCompilerCppAmbientMemberBinding({ name: 'byteOffset', receiver: 'typedArray' }, 'flight-cpp')).toEqual({
      kind: 'property',
      targetName: 'byte_offset',
    });
  });

  it('answers nothing for a member with no agreed spelling, so emission refuses rather than guesses', () => {
    expect(getCompilerCppAmbientMemberBinding({ name: 'sort', receiver: 'array' })).toBeUndefined();
    expect(getCompilerCppAmbientMemberBinding({ name: 'toFixed', receiver: 'number' })).toBeUndefined();
  });
});
