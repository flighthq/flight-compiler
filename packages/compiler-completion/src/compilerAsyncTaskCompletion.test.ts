import {
  createCompilerAsyncTaskCompletionPlan,
  createIrAwaitSemantics,
  isCompilerAsyncTaskCompletionFailure,
  isIrAwaitSemantics,
} from './compilerAsyncTaskCompletion.js';
import { createCompilerCompletionSet, isCompilerCompletionFailure } from './compilerCompletionSet.js';

describe('createCompilerAsyncTaskCompletionPlan', () => {
  it('maps reachable function-boundary completions to canonical task settlements', () => {
    const body = createCompilerCompletionSet([
      { kind: 'throw' },
      { kind: 'normal' },
      { kind: 'return' },
      { kind: 'return' },
    ]);
    const snapshot = structuredClone(body);

    const plan = createCompilerAsyncTaskCompletionPlan(body);

    expect(plan).toEqual({
      bodyStart: 'synchronous-until-suspension',
      resolution: 'normalize-value-task-or-thenable',
      schema: 'flight-compiler-async-task-completion/1',
      settlements: [
        { kind: 'resolve', source: 'implicit-undefined' },
        { kind: 'resolve', source: 'return-value' },
        { kind: 'reject', source: 'thrown-value' },
      ],
      taskCreation: 'before-body',
    });
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.settlements)).toBe(true);
    expect(plan.settlements.every(Object.isFrozen)).toBe(true);
    expect(body).toEqual(snapshot);
    expect(
      createCompilerAsyncTaskCompletionPlan({
        completions: [{ kind: 'throw' }, { kind: 'return' }, { kind: 'normal' }],
        schema: 'flight-compiler-completion-set/1',
      }),
    ).toEqual(plan);
    expect(createCompilerAsyncTaskCompletionPlan(createCompilerCompletionSet([])).settlements).toEqual([]);
  });

  it('rejects control flow that escaped the function boundary and validates unreachable input', () => {
    const fixtures = [
      createCompilerCompletionSet([{ kind: 'break' }]),
      createCompilerCompletionSet([{ kind: 'continue', target: 'outer' }]),
    ];

    for (const body of fixtures) {
      expect(() => createCompilerAsyncTaskCompletionPlan(body)).toThrow(
        expect.objectContaining({
          code: 'escaping-control-flow',
          kind: 'compiler-async-task-completion',
          path: ['bodyCompletion', 'completions', 0],
        }),
      );
    }
    try {
      createCompilerAsyncTaskCompletionPlan(fixtures[1]!);
    } catch (error) {
      expect(error).toMatchObject({ completion: 'continue', target: 'outer' });
    }
    expect(() => createCompilerAsyncTaskCompletionPlan({ schema: 'invalid', completions: [] } as never)).toThrow(
      expect.objectContaining({ kind: 'compiler-completion' }),
    );
    try {
      createCompilerAsyncTaskCompletionPlan({ schema: 'invalid', completions: [] } as never);
    } catch (error) {
      expect(isCompilerCompletionFailure(error)).toBe(true);
    }
  });
});

describe('createIrAwaitSemantics', () => {
  it('creates an immutable exact await boundary independent of task runtime syntax', () => {
    const first = createIrAwaitSemantics();
    const second = createIrAwaitSemantics();

    expect(first).toEqual({
      continuation: 'enqueue-after-settlement',
      fulfillment: 'resume-normal-with-value',
      operandEvaluation: 'once-before-suspension',
      rejection: 'resume-throw-with-reason',
      schema: 'flight-compiler-await-semantics/1',
      suspension: 'always-before-continuation',
      taskResolution: 'normalize-value-task-or-thenable',
    });
    expect(Object.isFrozen(first)).toBe(true);
    expect(first).not.toBe(second);
  });
});

describe('isCompilerAsyncTaskCompletionFailure', () => {
  it('accepts exact failures and rejects ordinary or malformed lookalikes', () => {
    const failures: unknown[] = [];
    for (const completion of [{ kind: 'break', target: 'outer' }, { kind: 'continue' }] as const) {
      try {
        createCompilerAsyncTaskCompletionPlan(createCompilerCompletionSet([completion]));
      } catch (error) {
        failures.push(error);
      }
    }
    const lookalike = {
      code: 'escaping-control-flow',
      completion: 'break',
      kind: 'compiler-async-task-completion',
      path: [],
    } as const;

    expect(failures).toHaveLength(2);
    expect(failures.every(isCompilerAsyncTaskCompletionFailure)).toBe(true);
    expect(isCompilerAsyncTaskCompletionFailure(new Error('ordinary'))).toBe(false);
    expect(
      isCompilerAsyncTaskCompletionFailure(Object.assign(new Error('lookalike'), lookalike, { code: 'unknown' })),
    ).toBe(false);
    expect(
      isCompilerAsyncTaskCompletionFailure(
        Object.assign(new Error('lookalike'), {
          ...lookalike,
          completion: 'return',
        }),
      ),
    ).toBe(false);
    expect(isCompilerAsyncTaskCompletionFailure(Object.assign(new Error('lookalike'), lookalike, { path: null }))).toBe(
      false,
    );
    expect(isCompilerAsyncTaskCompletionFailure(Object.assign(new Error('lookalike'), lookalike, { target: '' }))).toBe(
      false,
    );
  });
});

describe('isIrAwaitSemantics', () => {
  it('accepts only the exact versioned await contract', () => {
    const valid = createIrAwaitSemantics();
    const invalid: unknown[] = [
      null,
      [],
      { ...valid, continuation: 'inline' },
      { ...valid, extra: true },
      { ...valid, fulfillment: 'return' },
      { ...valid, operandEvaluation: 'twice' },
      { ...valid, rejection: 'reject-task' },
      { ...valid, schema: 'flight-compiler-await-semantics/2' },
      { ...valid, suspension: 'conditional' },
      { ...valid, taskResolution: 'native-only' },
    ];

    expect(isIrAwaitSemantics(valid)).toBe(true);
    expect(invalid.every((value) => !isIrAwaitSemantics(value))).toBe(true);
  });
});
