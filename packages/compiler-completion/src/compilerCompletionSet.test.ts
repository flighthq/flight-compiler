import type { CompilerCompletion, CompilerCompletionSet } from '../../compiler-types/src/index.js';
import {
  combineCompilerCompletionSetsAlternatively,
  combineCompilerCompletionSetsSequentially,
  createCompilerCompletionSet,
  isCompilerCompletionFailure,
} from './compilerCompletionSet.js';

describe('combineCompilerCompletionSetsAlternatively', () => {
  it('unions alternatives canonically without changing either input', () => {
    const left = createCompilerCompletionSet([{ kind: 'throw' }, { kind: 'break', target: 'outer' }]);
    const right = createCompilerCompletionSet([{ kind: 'normal' }, { kind: 'throw' }]);
    const snapshot = structuredClone([left, right]);

    const combined = combineCompilerCompletionSetsAlternatively([left, right]);

    expect(combined.completions).toEqual([{ kind: 'normal' }, { kind: 'break', target: 'outer' }, { kind: 'throw' }]);
    expect([left, right]).toEqual(snapshot);
    expect(combineCompilerCompletionSetsAlternatively([]).completions).toEqual([]);
    expect(combineCompilerCompletionSetsAlternatively([left, right])).toEqual(
      combineCompilerCompletionSetsAlternatively([right, left]),
    );
    expect(combineCompilerCompletionSetsAlternatively([left, left])).toEqual(left);
  });

  it('rejects malformed schemas, arrays, and nested completions even when another branch is valid', () => {
    const valid = createCompilerCompletionSet([{ kind: 'return' }]);
    const invalid = [
      null,
      [],
      { schema: 'invalid', completions: [] },
      { schema: 'flight-compiler-completion-set/1', completions: null },
      { schema: 'flight-compiler-completion-set/1', completions: [{ kind: 'invalid' }] },
    ];

    for (const set of invalid) {
      expect(() =>
        combineCompilerCompletionSetsAlternatively([valid, set as unknown as CompilerCompletionSet]),
      ).toThrow(expect.objectContaining({ kind: 'compiler-completion' }));
    }
    expect(() => combineCompilerCompletionSetsAlternatively(null as never)).toThrow(
      expect.objectContaining({ code: 'invalid-completion-set', path: ['sets'] }),
    );
  });
});

describe('combineCompilerCompletionSetsSequentially', () => {
  it('runs the next statement only for normal completion and preserves prior abrupt alternatives', () => {
    const first = createCompilerCompletionSet([{ kind: 'break' }, { kind: 'normal' }]);
    const second = createCompilerCompletionSet([{ kind: 'normal' }, { kind: 'throw' }]);
    const third = createCompilerCompletionSet([{ kind: 'return' }]);

    expect(combineCompilerCompletionSetsSequentially([first, second, third]).completions).toEqual([
      { kind: 'break' },
      { kind: 'return' },
      { kind: 'throw' },
    ]);
    expect(combineCompilerCompletionSetsSequentially([]).completions).toEqual([{ kind: 'normal' }]);
    expect(
      combineCompilerCompletionSetsSequentially([
        createCompilerCompletionSet([]),
        createCompilerCompletionSet([{ kind: 'normal' }]),
      ]).completions,
    ).toEqual([]);
    const leftGrouped = combineCompilerCompletionSetsSequentially([
      combineCompilerCompletionSetsSequentially([first, second]),
      third,
    ]);
    const rightGrouped = combineCompilerCompletionSetsSequentially([
      first,
      combineCompilerCompletionSetsSequentially([second, third]),
    ]);
    expect(leftGrouped).toEqual(rightGrouped);
  });

  it('validates unreachable tail sets instead of hiding malformed compiler state', () => {
    const abrupt = createCompilerCompletionSet([{ kind: 'return' }]);
    const malformed = { schema: 'invalid', completions: [] } as unknown as CompilerCompletionSet;

    expect(() => combineCompilerCompletionSetsSequentially([abrupt, malformed])).toThrow(
      expect.objectContaining({ code: 'invalid-completion-set', path: ['sets', 1] }),
    );
    expect(() => combineCompilerCompletionSetsSequentially(null as never)).toThrow(
      expect.objectContaining({ code: 'invalid-completion-set', path: ['sets'] }),
    );
  });
});

describe('createCompilerCompletionSet', () => {
  it('deduplicates, freezes, and canonically orders every completion and target identity', () => {
    const input: CompilerCompletion[] = [
      { kind: 'throw' },
      { kind: 'continue', target: 'zeta' },
      { kind: 'return' },
      { kind: 'break', target: 'zeta' },
      { kind: 'break', target: 'alpha' },
      { kind: 'break', target: undefined },
      { kind: 'continue' },
      { kind: 'normal' },
      { kind: 'break', target: 'alpha' },
    ];
    const snapshot = structuredClone(input);

    const set = createCompilerCompletionSet(input);

    expect(set).toEqual({
      completions: [
        { kind: 'normal' },
        { kind: 'break' },
        { kind: 'break', target: 'alpha' },
        { kind: 'break', target: 'zeta' },
        { kind: 'continue' },
        { kind: 'continue', target: 'zeta' },
        { kind: 'return' },
        { kind: 'throw' },
      ],
      schema: 'flight-compiler-completion-set/1',
    });
    expect(Object.isFrozen(set)).toBe(true);
    expect(Object.isFrozen(set.completions)).toBe(true);
    expect(set.completions.every(Object.isFrozen)).toBe(true);
    expect(Object.hasOwn(set.completions[1]!, 'target')).toBe(false);
    expect(Object.hasOwn(set.completions[4]!, 'target')).toBe(false);
    expect(input).toEqual(snapshot);
  });

  it('orders Unicode target identities by code unit without normalizing distinct labels', () => {
    const set = createCompilerCompletionSet([
      { kind: 'break', target: '\u00e9' },
      { kind: 'break', target: 'e\u0301' },
    ]);

    expect(set.completions).toEqual([
      { kind: 'break', target: 'e\u0301' },
      { kind: 'break', target: '\u00e9' },
    ]);
  });

  it('rejects unknown kinds, fields, and empty or non-string targets through exact codes', () => {
    const invalid = [
      { code: 'invalid-completion', completion: null },
      { code: 'invalid-completion', completion: [] },
      { code: 'invalid-completion', completion: { kind: 'yield' } },
      { code: 'invalid-completion', completion: { extra: true, kind: 'break' } },
      { code: 'invalid-completion-target', completion: { kind: 'break', target: '' } },
      { code: 'invalid-completion-target', completion: { kind: 'continue', target: 1 } },
      { code: 'invalid-completion', completion: { kind: 'normal', target: 'outer' } },
    ];

    for (const fixture of invalid) {
      expect(() => createCompilerCompletionSet([fixture.completion as never])).toThrow(
        expect.objectContaining({ code: fixture.code, kind: 'compiler-completion' }),
      );
    }
    expect(() => createCompilerCompletionSet(null as never)).toThrow(
      expect.objectContaining({ code: 'invalid-completion-set', path: ['completions'] }),
    );
  });
});

describe('isCompilerCompletionFailure', () => {
  it('accepts every failure code and rejects malformed lookalikes', () => {
    const failures: unknown[] = [];
    const attempts = [
      () => createCompilerCompletionSet([{ kind: 'invalid' } as never]),
      () => createCompilerCompletionSet([{ kind: 'break', target: '' }]),
      () => combineCompilerCompletionSetsAlternatively([{ schema: 'invalid', completions: [] } as never]),
    ];
    for (const attempt of attempts) {
      try {
        attempt();
      } catch (error) {
        failures.push(error);
      }
    }

    expect(failures).toHaveLength(attempts.length);
    expect(failures.every(isCompilerCompletionFailure)).toBe(true);
    expect(isCompilerCompletionFailure(new Error('ordinary'))).toBe(false);
    expect(
      isCompilerCompletionFailure(
        Object.assign(new Error('lookalike'), {
          code: 'unknown',
          kind: 'compiler-completion',
          path: [],
        }),
      ),
    ).toBe(false);
  });
});
