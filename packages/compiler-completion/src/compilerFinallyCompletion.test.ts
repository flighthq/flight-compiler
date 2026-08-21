import type { CompilerCompletion, CompilerCompletionSet } from '../../compiler-types/src/index.js';
import { createCompilerCompletionSet } from './compilerCompletionSet.js';
import { applyCompilerCompletionSetFinallyReplacement } from './compilerFinallyCompletion.js';

describe('applyCompilerCompletionSetFinallyReplacement', () => {
  it('restores every prior route when finally completes normally', () => {
    const routes: CompilerCompletion[] = [
      { kind: 'normal' },
      { kind: 'break' },
      { kind: 'break', target: 'outer' },
      { kind: 'continue' },
      { kind: 'continue', target: 'outer' },
      { kind: 'return' },
      { kind: 'throw' },
    ];
    const finalizer = createCompilerCompletionSet([{ kind: 'normal' }]);

    for (const route of routes) {
      const incoming = createCompilerCompletionSet([route]);
      expect(applyCompilerCompletionSetFinallyReplacement(incoming, finalizer)).toEqual(incoming);
    }
  });

  it('replaces every reachable prior route when finally completes abruptly', () => {
    const incoming = createCompilerCompletionSet([
      { kind: 'normal' },
      { kind: 'break', target: 'prior' },
      { kind: 'continue', target: 'prior' },
      { kind: 'return' },
      { kind: 'throw' },
    ]);
    const abruptRoutes: CompilerCompletion[] = [
      { kind: 'break', target: 'final' },
      { kind: 'continue', target: 'final' },
      { kind: 'return' },
      { kind: 'throw' },
    ];

    for (const abrupt of abruptRoutes) {
      const finalizer = createCompilerCompletionSet([abrupt]);
      expect(applyCompilerCompletionSetFinallyReplacement(incoming, finalizer)).toEqual(finalizer);
    }
  });

  it('unions restored prior routes with every possible abrupt finally replacement', () => {
    const incoming = createCompilerCompletionSet([{ kind: 'break', target: 'outer' }, { kind: 'return' }]);
    const finalizer = createCompilerCompletionSet([
      { kind: 'normal' },
      { kind: 'continue', target: 'cleanup' },
      { kind: 'throw' },
    ]);
    const incomingSnapshot = structuredClone(incoming);
    const finalizerSnapshot = structuredClone(finalizer);

    const result = applyCompilerCompletionSetFinallyReplacement(incoming, finalizer);

    expect(result.completions).toEqual([
      { kind: 'break', target: 'outer' },
      { kind: 'continue', target: 'cleanup' },
      { kind: 'return' },
      { kind: 'throw' },
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.completions)).toBe(true);
    expect(incoming).toEqual(incomingSnapshot);
    expect(finalizer).toEqual(finalizerSnapshot);
  });

  it('preserves unreachable flow and validates unreachable finalizer data', () => {
    const unreachable = createCompilerCompletionSet([]);
    const abrupt = createCompilerCompletionSet([{ kind: 'throw' }]);
    const malformed = { schema: 'invalid', completions: [] } as unknown as CompilerCompletionSet;

    expect(applyCompilerCompletionSetFinallyReplacement(unreachable, abrupt).completions).toEqual([]);
    expect(
      applyCompilerCompletionSetFinallyReplacement(
        createCompilerCompletionSet([{ kind: 'normal' }]),
        createCompilerCompletionSet([]),
      ).completions,
    ).toEqual([]);
    expect(() => applyCompilerCompletionSetFinallyReplacement(unreachable, malformed)).toThrow(
      expect.objectContaining({ code: 'invalid-completion-set' }),
    );
  });

  it('composes nested finalizers associatively', () => {
    const incoming = createCompilerCompletionSet([{ kind: 'normal' }, { kind: 'return' }]);
    const inner = createCompilerCompletionSet([{ kind: 'normal' }, { kind: 'throw' }]);
    const outer = createCompilerCompletionSet([{ kind: 'normal' }, { kind: 'break', target: 'outer' }]);

    const nested = applyCompilerCompletionSetFinallyReplacement(
      applyCompilerCompletionSetFinallyReplacement(incoming, inner),
      outer,
    );
    const grouped = applyCompilerCompletionSetFinallyReplacement(
      incoming,
      applyCompilerCompletionSetFinallyReplacement(inner, outer),
    );

    expect(nested).toEqual(grouped);
  });
});
