import {
  combineCompilerVariableInitializationCompletionStates,
  combineCompilerVariableInitializationSets,
  createCompilerVariableInitializationCompletionAlternative,
  createCompilerVariableInitializationCompletionWithState,
} from './compilerVariableInitializationCompletion.js';

describe('combineCompilerVariableInitializationCompletionStates', () => {
  it('returns only facts present for every reachable completion kind', () => {
    expect(
      combineCompilerVariableInitializationCompletionStates({
        break: new Set(['shared', 'break']),
        normal: new Set(['shared', 'normal']),
        throw: new Set(['shared', 'throw']),
      }),
    ).toEqual(new Set(['shared']));
    expect(combineCompilerVariableInitializationCompletionStates({})).toBeUndefined();
  });
});

describe('combineCompilerVariableInitializationSets', () => {
  it('clones a sole reachable state, intersects alternatives, and preserves empty states', () => {
    const state = new Set(['shared', 'left']);
    const sole = combineCompilerVariableInitializationSets(state, undefined);

    expect(sole).toEqual(state);
    expect(sole).not.toBe(state);
    expect(combineCompilerVariableInitializationSets(state, new Set(['shared', 'right']))).toEqual(new Set(['shared']));
    expect(combineCompilerVariableInitializationSets(new Set(), new Set(['right']))).toEqual(new Set());
    expect(combineCompilerVariableInitializationSets(undefined, undefined)).toBeUndefined();
  });
});

describe('createCompilerVariableInitializationCompletionAlternative', () => {
  it('intersects facts for the same completion and preserves separately reachable completions', () => {
    const left = { break: new Set(['shared', 'left']), normal: new Set(['entry']) };
    const right = { break: new Set(['shared', 'right']), return: new Set(['returned']) };
    const alternative = createCompilerVariableInitializationCompletionAlternative(left, right);

    expect([...alternative.break!]).toEqual(['shared']);
    expect([...alternative.normal!]).toEqual(['entry']);
    expect([...alternative.return!]).toEqual(['returned']);
    expect(alternative.continue).toBeUndefined();
    expect(left.break).toEqual(new Set(['shared', 'left']));
    expect(right.break).toEqual(new Set(['shared', 'right']));
  });
});

describe('createCompilerVariableInitializationCompletionWithState', () => {
  it('adds a completion state without mutating its input and intersects an existing state', () => {
    const completion = { normal: new Set(['shared', 'before']) };
    const added = createCompilerVariableInitializationCompletionWithState(
      completion,
      'normal',
      new Set(['shared', 'after']),
    );
    const unchanged = createCompilerVariableInitializationCompletionWithState(completion, 'break', undefined);

    expect([...added.normal!]).toEqual(['shared']);
    expect(completion.normal).toEqual(new Set(['shared', 'before']));
    expect(unchanged).toBe(completion);
  });
});
