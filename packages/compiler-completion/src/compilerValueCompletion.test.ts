import type {
  CompilerCompletionValueSource,
  CompilerValueCompletionPath,
  CompilerValueCompletionPathSet,
} from '../../compiler-types/src/index.js';
import {
  applyCompilerValueCompletionPathSetCatchReplacement,
  applyCompilerValueCompletionPathSetFinallyReplacement,
  combineCompilerValueCompletionPathSetsAlternatively,
  combineCompilerValueCompletionPathSetsSequentially,
  createCompilerValueCompletionPathSet,
  isCompilerValueCompletionFailure,
} from './compilerValueCompletion.js';

describe('applyCompilerValueCompletionPathSetCatchReplacement', () => {
  it('intercepts every thrown value source while preserving uncaught and handler completions', () => {
    const incoming = createCompilerValueCompletionPathSet([
      path('normal', ['try', 'end'], expressionValue(['try', 'value'], 'result')),
      path('throw', ['try', 0], expressionValue(['try', 0, 'expression'], 'result')),
      path('throw', ['try', 1], expressionValue(['try', 1, 'callee'], 'abrupt')),
    ]);
    const handler = createCompilerValueCompletionPathSet([
      path('normal', ['catch', 'end'], { kind: 'implicitUndefined' }),
      path('return', ['catch', 0], { kind: 'empty' }),
    ]);

    const replacement = applyCompilerValueCompletionPathSetCatchReplacement(incoming, handler);

    expect(replacement.schema).toBe('flight-compiler-value-completion-catch-replacement/1');
    expect(replacement.completions.paths.map((completion) => completion.kind)).toEqual(['normal', 'normal', 'return']);
    expect(replacement.interceptions).toEqual([
      { path: ['try', 0], value: expressionValue(['try', 0, 'expression'], 'result') },
      { path: ['try', 1], value: expressionValue(['try', 1, 'callee'], 'abrupt') },
    ]);
    expect(isDeeplyFrozen(replacement, new WeakSet())).toBe(true);
  });

  it('returns an independent normalized input when no throw is reachable and still validates the handler', () => {
    const incoming = createCompilerValueCompletionPathSet([path('return', ['body', 0], { kind: 'implicitUndefined' })]);
    const result = applyCompilerValueCompletionPathSetCatchReplacement(
      incoming,
      createCompilerValueCompletionPathSet([path('throw', ['catch', 0], { kind: 'empty' })]),
    );

    expect(result).toEqual({
      completions: incoming,
      interceptions: [],
      schema: 'flight-compiler-value-completion-catch-replacement/1',
    });
    expect(result.completions).not.toBe(incoming);
    expect(() => applyCompilerValueCompletionPathSetCatchReplacement(incoming, null as never)).toThrow(
      expect.objectContaining({ code: 'invalid-path-set', path: ['sets', 0] }),
    );
  });
});

describe('applyCompilerValueCompletionPathSetFinallyReplacement', () => {
  it('restores every incoming value after normal cleanup and updates empty abrupt cleanup values', () => {
    const incoming = createCompilerValueCompletionPathSet([
      path('return', ['body', 0], expressionValue(['body', 0, 'expression'], 'result')),
      path('throw', ['body', 1], { kind: 'implicitUndefined' }),
    ]);
    const cleanup = createCompilerValueCompletionPathSet([
      path('normal', ['finally', 'end'], expressionValue(['finally', 0], 'result')),
      path('break', ['finally', 1], { kind: 'empty' }, 'outer'),
      path('throw', ['finally', 2], expressionValue(['finally', 2, 'expression'], 'result')),
    ]);

    const replacement = applyCompilerValueCompletionPathSetFinallyReplacement(incoming, cleanup);

    expect(replacement.paths).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'return', value: expressionValue(['body', 0, 'expression'], 'result') }),
        expect.objectContaining({ kind: 'throw', value: { kind: 'implicitUndefined' } }),
        expect.objectContaining({ kind: 'throw', value: expressionValue(['finally', 2, 'expression'], 'result') }),
        expect.objectContaining({
          kind: 'break',
          target: 'outer',
          value: expressionValue(['body', 0, 'expression'], 'result'),
        }),
        expect.objectContaining({ kind: 'break', target: 'outer', value: { kind: 'implicitUndefined' } }),
      ]),
    );
    expect(replacement.paths).toHaveLength(5);
  });

  it('handles unreachable input, non-completing cleanup, and normal-only cleanup without special values', () => {
    const incoming = createCompilerValueCompletionPathSet([path('normal', ['body'], { kind: 'empty' })]);
    const normal = createCompilerValueCompletionPathSet([path('normal', ['finally'], { kind: 'implicitUndefined' })]);

    expect(
      applyCompilerValueCompletionPathSetFinallyReplacement(createCompilerValueCompletionPathSet([]), normal).paths,
    ).toEqual([]);
    expect(
      applyCompilerValueCompletionPathSetFinallyReplacement(incoming, createCompilerValueCompletionPathSet([])).paths,
    ).toEqual([]);
    expect(applyCompilerValueCompletionPathSetFinallyReplacement(incoming, normal)).toEqual(incoming);
  });
});

describe('combineCompilerValueCompletionPathSetsAlternatively', () => {
  it('forms a canonical commutative idempotent union without changing inputs', () => {
    const left = createCompilerValueCompletionPathSet([
      path('throw', ['left'], { kind: 'empty' }),
      path('break', ['left', 1], { kind: 'empty' }, 'outer'),
    ]);
    const right = createCompilerValueCompletionPathSet([
      path('normal', ['right'], { kind: 'implicitUndefined' }),
      path('throw', ['left'], { kind: 'empty' }),
    ]);
    const snapshot = structuredClone([left, right]);

    const combined = combineCompilerValueCompletionPathSetsAlternatively([left, right]);

    expect(combined.paths.map((completion) => completion.kind)).toEqual(['normal', 'break', 'throw']);
    expect(combineCompilerValueCompletionPathSetsAlternatively([right, left])).toEqual(combined);
    expect(combineCompilerValueCompletionPathSetsAlternatively([left, left])).toEqual(left);
    expect(combineCompilerValueCompletionPathSetsAlternatively([]).paths).toEqual([]);
    expect([left, right]).toEqual(snapshot);
  });
});

describe('combineCompilerValueCompletionPathSetsSequentially', () => {
  it('updates empty values, preserves abrupt paths, forms the normal-path product, and is associative', () => {
    const first = createCompilerValueCompletionPathSet([
      path('normal', ['first', 0], expressionValue(['first', 0], 'result')),
      path('normal', ['first', 1], { kind: 'implicitUndefined' }),
      path('throw', ['first', 2], { kind: 'empty' }),
    ]);
    const second = createCompilerValueCompletionPathSet([
      path('normal', ['second', 0], { kind: 'empty' }),
      path('return', ['second', 1], { kind: 'implicitUndefined' }),
    ]);
    const third = createCompilerValueCompletionPathSet([path('throw', ['third'], { kind: 'empty' })]);

    const combined = combineCompilerValueCompletionPathSetsSequentially([first, second, third]);
    const leftGrouped = combineCompilerValueCompletionPathSetsSequentially([
      combineCompilerValueCompletionPathSetsSequentially([first, second]),
      third,
    ]);
    const rightGrouped = combineCompilerValueCompletionPathSetsSequentially([
      first,
      combineCompilerValueCompletionPathSetsSequentially([second, third]),
    ]);

    expect(combined.paths).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'throw', path: ['first', 2], value: { kind: 'empty' } }),
        expect.objectContaining({ kind: 'throw', path: ['third'], value: { kind: 'implicitUndefined' } }),
        expect.objectContaining({
          kind: 'throw',
          path: ['third'],
          value: expressionValue(['first', 0], 'result'),
        }),
        expect.objectContaining({ kind: 'return', value: { kind: 'implicitUndefined' } }),
      ]),
    );
    expect(combined.paths).toHaveLength(4);
    expect(leftGrouped).toEqual(rightGrouped);
    expect(combineCompilerValueCompletionPathSetsSequentially([]).paths).toEqual([
      { kind: 'normal', path: [], value: { kind: 'empty' } },
    ]);
    expect(
      combineCompilerValueCompletionPathSetsSequentially([
        createCompilerValueCompletionPathSet([]),
        createCompilerValueCompletionPathSet([path('normal', ['unreachable'], { kind: 'empty' })]),
      ]).paths,
    ).toEqual([]);
  });

  it('validates every unreachable tail set before composition', () => {
    const abrupt = createCompilerValueCompletionPathSet([path('return', ['body'], { kind: 'implicitUndefined' })]);

    expect(() =>
      combineCompilerValueCompletionPathSetsSequentially([
        abrupt,
        { paths: [], schema: 'invalid' } as unknown as CompilerValueCompletionPathSet,
      ]),
    ).toThrow(expect.objectContaining({ code: 'invalid-path-set', path: ['sets', 1] }));
  });
});

describe('createCompilerValueCompletionPathSet', () => {
  it('normalizes, deduplicates, deeply freezes, and canonically orders every kind, target, path, and value source', () => {
    const input: CompilerValueCompletionPath[] = [
      path('throw', ['zeta'], expressionValue(['zeta', 'expression'], 'abrupt')),
      path('continue', ['body', 2], { kind: 'empty' }, 'zeta'),
      path('return', ['body', 1], { kind: 'implicitUndefined' }),
      path('break', ['body', 0], { kind: 'empty' }),
      path('break', ['body', 0], { kind: 'empty' }),
      path('normal', ['end'], expressionValue(['body', 3], 'result')),
    ];
    const snapshot = structuredClone(input);

    const set = createCompilerValueCompletionPathSet(input);

    expect(set.paths.map((completion) => completion.kind)).toEqual(['normal', 'break', 'continue', 'return', 'throw']);
    expect(Object.hasOwn(set.paths[1]!, 'target')).toBe(false);
    expect(isDeeplyFrozen(set, new WeakSet())).toBe(true);
    expect(input).toEqual(snapshot);
  });

  it('normalizes a carried value when its binding identity is structurally valid', () => {
    const set = createCompilerValueCompletionPathSet([
      path('normal', ['body'], { kind: 'carried', binding: { id: 'tmp_0', name: '__result' } } as never),
    ]);

    expect(set.paths[0]!.value).toEqual({ kind: 'carried', binding: { id: 'tmp_0', name: '__result' } });
    expect(isDeeplyFrozen(set, new WeakSet())).toBe(true);
  });

  it('rejects carried values with missing, empty-id, non-object, or extra-field bindings', () => {
    const carriedCases: Array<Readonly<{ label: string; value: unknown }>> = [
      { label: 'no binding field', value: { kind: 'carried' } },
      { label: 'extra field', value: { kind: 'carried', binding: { id: 'x', name: 'y' }, extra: true } },
      { label: 'null binding', value: { kind: 'carried', binding: null } },
      { label: 'string binding', value: { kind: 'carried', binding: 'not-an-object' } },
      { label: 'binding missing id', value: { kind: 'carried', binding: { name: 'y' } } },
      { label: 'binding non-string id', value: { kind: 'carried', binding: { id: 123, name: 'y' } } },
      { label: 'binding empty id', value: { kind: 'carried', binding: { id: '', name: 'y' } } },
      { label: 'binding missing name', value: { kind: 'carried', binding: { id: 'x' } } },
      { label: 'binding non-string name', value: { kind: 'carried', binding: { id: 'x', name: 42 } } },
    ];

    for (const { label, value } of carriedCases) {
      expect(() => createCompilerValueCompletionPathSet([path('normal', ['body'], value as never)]), label).toThrow(
        expect.objectContaining({ code: 'invalid-completion-value', kind: 'compiler-value-completion' }),
      );
    }
  });

  it('keeps Unicode path and target identity exact and orders it by code unit', () => {
    const set = createCompilerValueCompletionPathSet([
      path('break', ['é'], { kind: 'empty' }, 'é'),
      path('break', ['é'], { kind: 'empty' }, 'é'),
    ]);

    expect(set.paths.map((completion) => completion.target)).toEqual(['é', 'é']);
  });

  it('rejects malformed sets, completions, paths, targets, values, and unknown fields through exact codes', () => {
    const valid = path('normal', ['body'], { kind: 'empty' });
    const invalid: Array<Readonly<{ code: string; completion: unknown }>> = [
      { code: 'invalid-completion-kind', completion: null },
      { code: 'invalid-completion-kind', completion: [] },
      { code: 'invalid-completion-kind', completion: { ...valid, kind: 'yield' } },
      { code: 'invalid-completion-kind', completion: { ...path('break', [], { kind: 'empty' }), extra: true } },
      { code: 'invalid-completion-target', completion: { ...path('break', [], { kind: 'empty' }), target: '' } },
      { code: 'invalid-completion-target', completion: { ...path('continue', [], { kind: 'empty' }), target: 1 } },
      { code: 'invalid-completion-kind', completion: { ...valid, target: 'outer' } },
      { code: 'invalid-completion-kind', completion: { ...valid, extra: true } },
      { code: 'invalid-completion-path', completion: { ...valid, path: null } },
      { code: 'invalid-completion-path', completion: { ...valid, path: [''] } },
      { code: 'invalid-completion-path', completion: { ...valid, path: [-1] } },
      { code: 'invalid-completion-path', completion: { ...valid, path: [1.5] } },
      { code: 'invalid-completion-value', completion: { ...valid, value: null } },
      { code: 'invalid-completion-value', completion: { ...valid, value: [] } },
      { code: 'invalid-completion-value', completion: { ...valid, value: { kind: 'unknown' } } },
      { code: 'invalid-completion-value', completion: { ...valid, value: { extra: true, kind: 'empty' } } },
      {
        code: 'invalid-completion-value',
        completion: { ...valid, value: { extra: true, kind: 'implicitUndefined' } },
      },
      { code: 'invalid-completion-value', completion: { ...valid, value: { kind: 'expression' } } },
      {
        code: 'invalid-completion-value',
        completion: { ...valid, value: { kind: 'expression', path: [''], phase: 'result' } },
      },
      {
        code: 'invalid-completion-value',
        completion: { ...valid, value: { kind: 'expression', path: [], phase: 'unknown' } },
      },
    ];

    for (const fixture of invalid) {
      expect(() => createCompilerValueCompletionPathSet([fixture.completion as never])).toThrow(
        expect.objectContaining({ code: fixture.code, kind: 'compiler-value-completion' }),
      );
    }
    expect(() => createCompilerValueCompletionPathSet(null as never)).toThrow(
      expect.objectContaining({ code: 'invalid-path-set', path: ['paths'] }),
    );
  });

  it('rejects malformed schemas, set arrays, path collections, and nested values in every alternative', () => {
    const valid = createCompilerValueCompletionPathSet([path('normal', [], { kind: 'empty' })]);
    const invalid = [
      null,
      [],
      { paths: [], schema: 'invalid' },
      { paths: null, schema: 'flight-compiler-value-completion-path-set/1' },
      { paths: [{ kind: 'invalid' }], schema: 'flight-compiler-value-completion-path-set/1' },
    ];

    for (const set of invalid) {
      expect(() =>
        combineCompilerValueCompletionPathSetsAlternatively([valid, set as unknown as CompilerValueCompletionPathSet]),
      ).toThrow(expect.objectContaining({ kind: 'compiler-value-completion' }));
    }
    expect(() => combineCompilerValueCompletionPathSetsAlternatively(null as never)).toThrow(
      expect.objectContaining({ code: 'invalid-path-set', path: ['sets'] }),
    );
  });
});

describe('isCompilerValueCompletionFailure', () => {
  it('accepts every failure code and rejects malformed lookalikes', () => {
    const attempts = [
      () => createCompilerValueCompletionPathSet([{ kind: 'invalid' } as never]),
      () => createCompilerValueCompletionPathSet([{ ...path('normal', [], { kind: 'empty' }), path: null } as never]),
      () => createCompilerValueCompletionPathSet([path('break', [], { kind: 'empty' }, '')]),
      () => createCompilerValueCompletionPathSet([{ ...path('normal', [], { kind: 'empty' }), value: null } as never]),
      () => combineCompilerValueCompletionPathSetsAlternatively(null as never),
    ];
    const failures: unknown[] = [];
    for (const attempt of attempts) {
      try {
        attempt();
      } catch (error) {
        failures.push(error);
      }
    }

    expect(failures).toHaveLength(attempts.length);
    expect(failures.every(isCompilerValueCompletionFailure)).toBe(true);
    expect(isCompilerValueCompletionFailure(new Error('ordinary'))).toBe(false);
    expect(
      isCompilerValueCompletionFailure(
        Object.assign(new Error('lookalike'), { code: 'unknown', kind: 'compiler-value-completion', path: [] }),
      ),
    ).toBe(false);
    expect(
      isCompilerValueCompletionFailure(
        Object.assign(new Error('lookalike'), {
          code: 'invalid-path-set',
          kind: 'compiler-value-completion',
          path: [''],
        }),
      ),
    ).toBe(false);
  });
});

function expressionValue(
  expressionPath: readonly (number | string)[],
  phase: Extract<CompilerCompletionValueSource, { kind: 'expression' }>['phase'],
): CompilerCompletionValueSource {
  return { kind: 'expression', path: expressionPath, phase };
}

function isDeeplyFrozen(value: unknown, seen: WeakSet<object>): boolean {
  if (!value || typeof value !== 'object' || seen.has(value)) return true;
  seen.add(value);
  return Object.isFrozen(value) && Object.values(value).every((child) => isDeeplyFrozen(child, seen));
}

function path(
  kind: CompilerValueCompletionPath['kind'],
  completionPath: readonly (number | string)[],
  value: CompilerCompletionValueSource,
  target?: string,
): CompilerValueCompletionPath {
  if (kind === 'break' || kind === 'continue') {
    return { kind, path: completionPath, ...(target === undefined ? {} : { target }), value };
  }
  return { kind, path: completionPath, value };
}
