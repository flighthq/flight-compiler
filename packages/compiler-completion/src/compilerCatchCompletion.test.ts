import type { CompilerCompletion, CompilerCompletionSet } from '../../compiler-types/src/index.js';
import {
  applyCompilerCompletionSetCatchReplacement,
  createIrCatchSemantics,
  isCompilerCatchCompletionFailure,
  isIrCatchSemantics,
} from './compilerCatchCompletion.js';
import { createCompilerCompletionSet } from './compilerCompletionSet.js';
import { applyCompilerCompletionSetFinallyReplacement } from './compilerFinallyCompletion.js';

describe('applyCompilerCompletionSetCatchReplacement', () => {
  it('replaces only caught throw routes and preserves every uncaught completion', () => {
    const incomingRoutes: CompilerCompletion[] = [
      { kind: 'normal' },
      { kind: 'break', target: 'outer' },
      { kind: 'continue', target: 'outer' },
      { kind: 'return' },
      { kind: 'throw' },
    ];
    const catchCompletion = createCompilerCompletionSet([
      { kind: 'normal' },
      { kind: 'continue', target: 'handler' },
      { kind: 'return' },
    ]);
    const incoming = createCompilerCompletionSet(incomingRoutes);
    const snapshot = structuredClone([incoming, catchCompletion]);

    const result = applyCompilerCompletionSetCatchReplacement(incoming, catchCompletion);

    expect(result.completions).toEqual([
      { kind: 'normal' },
      { kind: 'break', target: 'outer' },
      { kind: 'continue', target: 'handler' },
      { kind: 'continue', target: 'outer' },
      { kind: 'return' },
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.completions)).toBe(true);
    expect([incoming, catchCompletion]).toEqual(snapshot);
  });

  it('runs the handler only for reachable throw and propagates rethrow', () => {
    const noThrow = createCompilerCompletionSet([{ kind: 'normal' }, { kind: 'return' }]);
    const rethrow = createCompilerCompletionSet([{ kind: 'throw' }]);

    expect(applyCompilerCompletionSetCatchReplacement(noThrow, rethrow)).toEqual(noThrow);
    expect(
      applyCompilerCompletionSetCatchReplacement(createCompilerCompletionSet([{ kind: 'throw' }]), rethrow),
    ).toEqual(rethrow);
    expect(
      applyCompilerCompletionSetCatchReplacement(
        createCompilerCompletionSet([{ kind: 'throw' }]),
        createCompilerCompletionSet([]),
      ).completions,
    ).toEqual([]);
    expect(
      applyCompilerCompletionSetCatchReplacement(
        createCompilerCompletionSet([]),
        createCompilerCompletionSet([{ kind: 'normal' }]),
      ).completions,
    ).toEqual([]);
  });

  it('applies catch before finally so abrupt cleanup replaces handled or rethrown flow', () => {
    const incoming = createCompilerCompletionSet([{ kind: 'return' }, { kind: 'throw' }]);
    const handler = createCompilerCompletionSet([{ kind: 'normal' }, { kind: 'throw' }]);
    const finalizer = createCompilerCompletionSet([{ kind: 'normal' }, { kind: 'break', target: 'cleanup' }]);

    const handled = applyCompilerCompletionSetCatchReplacement(incoming, handler);
    const completed = applyCompilerCompletionSetFinallyReplacement(handled, finalizer);

    expect(completed.completions).toEqual([
      { kind: 'normal' },
      { kind: 'break', target: 'cleanup' },
      { kind: 'return' },
      { kind: 'throw' },
    ]);
    expect(
      applyCompilerCompletionSetFinallyReplacement(
        applyCompilerCompletionSetCatchReplacement(
          createCompilerCompletionSet([{ kind: 'throw' }]),
          createCompilerCompletionSet([{ kind: 'normal' }]),
        ),
        createCompilerCompletionSet([{ kind: 'return' }]),
      ).completions,
    ).toEqual([{ kind: 'return' }]);
  });

  it('validates unreachable catch input instead of hiding malformed compiler state', () => {
    const malformed = { schema: 'invalid', completions: [] } as unknown as CompilerCompletionSet;

    expect(() =>
      applyCompilerCompletionSetCatchReplacement(createCompilerCompletionSet([{ kind: 'normal' }]), malformed),
    ).toThrow(expect.objectContaining({ code: 'invalid-completion-set', path: ['sets', 0] }));
  });
});

describe('createIrCatchSemantics', () => {
  it('creates exact immutable binding initialization for present and absent bindings', () => {
    const present = createIrCatchSemantics('present');
    const absent = createIrCatchSemantics('absent');

    expect(present).toEqual({
      bindingInitialization: { kind: 'initialize', source: 'thrown-value', timing: 'before-body' },
      bodyExecution: 'once-per-caught-throw',
      catchCompletion: 'propagate',
      interceptedCompletion: 'throw',
      schema: 'flight-compiler-catch-semantics/1',
      uncaughtCompletion: 'preserve',
    });
    expect(absent.bindingInitialization).toEqual({ kind: 'discard' });
    expect(Object.isFrozen(present)).toBe(true);
    expect(Object.isFrozen(present.bindingInitialization)).toBe(true);
    expect(Object.isFrozen(absent.bindingInitialization)).toBe(true);
    expect(createIrCatchSemantics('present')).not.toBe(present);
  });

  it('rejects an unknown binding-presence request through stable tagged data', () => {
    expect(() => createIrCatchSemantics('unknown' as never)).toThrow(
      expect.objectContaining({
        code: 'invalid-binding-presence',
        kind: 'compiler-catch-completion',
        path: ['bindingPresence'],
      }),
    );
  });
});

describe('isCompilerCatchCompletionFailure', () => {
  it('accepts exact failures and rejects ordinary or malformed lookalikes', () => {
    let failure: unknown;
    try {
      createIrCatchSemantics(null as never);
    } catch (error) {
      failure = error;
    }
    const lookalike = {
      code: 'invalid-binding-presence',
      kind: 'compiler-catch-completion',
      path: ['bindingPresence'],
    } as const;

    expect(isCompilerCatchCompletionFailure(failure)).toBe(true);
    expect(isCompilerCatchCompletionFailure(new Error('ordinary'))).toBe(false);
    expect(isCompilerCatchCompletionFailure(lookalike)).toBe(false);
    expect(
      isCompilerCatchCompletionFailure(Object.assign(new Error('lookalike'), lookalike, { code: 'unknown' })),
    ).toBe(false);
    expect(isCompilerCatchCompletionFailure(Object.assign(new Error('lookalike'), lookalike, { path: null }))).toBe(
      false,
    );
  });
});

describe('isIrCatchSemantics', () => {
  it('accepts only exact present-binding and absent-binding contracts', () => {
    const present = createIrCatchSemantics('present');
    const absent = createIrCatchSemantics('absent');
    const invalid: unknown[] = [
      null,
      [],
      { ...present, bindingInitialization: null },
      { ...present, bindingInitialization: [] },
      { ...present, bindingInitialization: {} },
      { ...present, bindingInitialization: { kind: 'initialize', source: 'copy', timing: 'before-body' } },
      { ...present, bindingInitialization: { kind: 'initialize', source: 'thrown-value', timing: 'after-body' } },
      {
        ...present,
        bindingInitialization: { extra: true, kind: 'initialize', source: 'thrown-value', timing: 'before-body' },
      },
      { ...absent, bindingInitialization: { extra: true, kind: 'discard' } },
      { ...present, bodyExecution: 'sometimes' },
      { ...present, catchCompletion: 'consume' },
      { ...present, extra: true },
      { ...present, interceptedCompletion: 'return' },
      { ...present, schema: 'flight-compiler-catch-semantics/2' },
      { ...present, uncaughtCompletion: 'discard' },
    ];

    expect(isIrCatchSemantics(present)).toBe(true);
    expect(isIrCatchSemantics(absent)).toBe(true);
    expect(invalid.every((value) => !isIrCatchSemantics(value))).toBe(true);
  });
});
