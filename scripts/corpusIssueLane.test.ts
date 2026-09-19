import { describe, expect, it } from 'vitest';

import { classifyCorpusIssueLane, describeCorpusIssueLane } from './corpusIssueLane.js';

describe('classifyCorpusIssueLane', () => {
  it('calls a missing fact the compiler-evidence lane', () => {
    expect(classifyCorpusIssueLane('contextual optionalSingle construction requires expression type evidence')).toBe(
      'compiler-evidence',
    );
    expect(classifyCorpusIssueLane('typeof requires closed runtime type evidence')).toBe('compiler-evidence');
  });

  it('calls a missing capability the runtime lane', () => {
    expect(classifyCorpusIssueLane('ambient value Object member values has no C++ binding')).toBe('runtime');
    expect(classifyCorpusIssueLane('runtime external symbol binding plan is incomplete (missing: timers.global)')).toBe(
      'runtime',
    );
    expect(classifyCorpusIssueLane('flight-cpp WeakMap value requires a proven C++ representation')).toBe('runtime');
  });

  it('calls a missing lowering the compiler-emission lane', () => {
    expect(classifyCorpusIssueLane('property radius on a C++ variant requires proven union member access')).toBe(
      'compiler-emission',
    );
    expect(classifyCorpusIssueLane('Partial<T> requires a statically resolvable C++ object shape')).toBe(
      'compiler-emission',
    );
  });

  // The messages are not uniform in their verb: some say `require` and some `requires`. A pattern that
  // carries the verb matches only one of the two, which silently filed 139 of 305 issues as
  // unclassified until the patterns became noun phrases. Each of these is that shape.
  it('matches a message whose verb is plural', () => {
    expect(classifyCorpusIssueLane('typeOf types require C++ type computation lowering')).toBe('compiler-emission');
    expect(
      classifyCorpusIssueLane('intersection types require C++ multiple-inheritance lowering: no shape for X'),
    ).toBe('compiler-emission');
    expect(classifyCorpusIssueLane('typeof types require C++ type computation lowering')).toBe('compiler-emission');
  });

  it('leaves a representation refusal unclassified rather than guessing its owner', () => {
    expect(classifyCorpusIssueLane('a message nobody has classified yet')).toBe('unclassified');
  });
});

describe('describeCorpusIssueLane', () => {
  it('explains each lane', () => {
    expect(describeCorpusIssueLane('runtime')).toContain('runtime contract');
    expect(describeCorpusIssueLane('unclassified')).toContain('not determined');
  });
});
