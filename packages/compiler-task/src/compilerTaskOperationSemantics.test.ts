import type { CompilerTaskOperationName } from '../../compiler-types/src/index.js';
import {
  createCompilerTaskOperationSemantics,
  isCompilerTaskOperationSemanticsFailure,
} from './compilerTaskOperationSemantics.js';

describe('createCompilerTaskOperationSemantics', () => {
  it('defines exact ready assimilation and exact rejection without assimilation', () => {
    expect(createCompilerTaskOperationSemantics('ready')).toEqual({
      inputObservation: 'once',
      operation: 'ready',
      schema: 'flight-compiler-task-operation-semantics/1',
      selfResolution: 'reject-type-error',
      settlement: 'normalize-value-task-or-thenable',
      settlementRace: 'first-call-wins',
      taskIdentity: 'reuse-compatible-task-otherwise-new',
      thenableFailure: 'reject-if-get-or-call-throws-before-settlement',
      thenableMethod: 'get-once-call-once',
    });
    expect(createCompilerTaskOperationSemantics('reject')).toEqual({
      operation: 'reject',
      reasonObservation: 'once',
      schema: 'flight-compiler-task-operation-semantics/1',
      settlement: 'reject-exact-reason-without-assimilation',
      taskCreation: 'before-reason-observation',
    });
  });

  it('defines ordered join-all fulfillment, empty input, iteration failure, and fail-fast rejection', () => {
    expect(createCompilerTaskOperationSemantics('joinAll')).toEqual({
      elementResolution: 'normalize-value-task-or-thenable',
      emptyInput: 'resolve-empty-list',
      fulfillment: 'ordered-values-after-all-fulfill',
      iteration: 'get-iterator-once-consume-in-order',
      iterationFailure: 'reject',
      iteratorClose: 'on-abrupt-iteration',
      operation: 'joinAll',
      rejection: 'first-observed-rejection',
      schema: 'flight-compiler-task-operation-semantics/1',
      taskCreation: 'before-iteration',
    });
  });

  it('defines derived-task scheduling, missing-handler forwarding, and handler result normalization', () => {
    expect(createCompilerTaskOperationSemantics('then')).toEqual({
      continuation: 'enqueue-after-source-settlement',
      derivedTask: 'always-new',
      fulfillmentHandlerArgument: 'source-value',
      fulfillmentHandler: 'normalize-return-reject-on-throw',
      handlerThis: 'undefined',
      missingFulfillmentHandler: 'forward-fulfillment',
      missingRejectionHandler: 'forward-rejection',
      nonCallableHandler: 'treat-as-missing',
      operation: 'then',
      rejectionHandlerArgument: 'source-reason',
      rejectionHandler: 'normalize-return-reject-on-throw',
      schema: 'flight-compiler-task-operation-semantics/1',
      taskCreation: 'before-handler-registration',
    });
    expect(createCompilerTaskOperationSemantics('catch')).toEqual({
      equivalent: 'then-with-missing-fulfillment-handler',
      operation: 'catch',
      schema: 'flight-compiler-task-operation-semantics/1',
    });
  });

  it('defines finally transparency and cleanup-failure replacement', () => {
    expect(createCompilerTaskOperationSemantics('finally')).toEqual({
      continuation: 'enqueue-after-source-settlement',
      derivedTask: 'always-new',
      handlerArguments: 'none',
      handlerFailure: 'replace-with-rejection',
      handlerResult: 'normalize-and-ignore-fulfillment-value',
      handlerThis: 'undefined',
      nonCallableHandler: 'forward-source-settlement',
      operation: 'finally',
      schema: 'flight-compiler-task-operation-semantics/1',
      sourceSettlement: 'preserve-after-handler-fulfillment',
      taskCreation: 'before-handler-registration',
    });
  });

  it('returns fresh immutable plans and rejects unknown runtime operations', () => {
    const operations: readonly CompilerTaskOperationName[] = ['catch', 'finally', 'joinAll', 'ready', 'reject', 'then'];
    for (const operation of operations) {
      const first = createCompilerTaskOperationSemantics(operation);
      const second = createCompilerTaskOperationSemantics(operation);
      expect(Object.isFrozen(first)).toBe(true);
      expect(first).toEqual(second);
      expect(first).not.toBe(second);
    }
    for (const operation of ['construct', null] as const) {
      expect(() => createCompilerTaskOperationSemantics(operation as never)).toThrow(
        expect.objectContaining({
          code: 'unknown-operation',
          kind: 'compiler-task-operation-semantics',
          received: operation === null ? 'object' : operation,
        }),
      );
    }
  });
});

describe('isCompilerTaskOperationSemanticsFailure', () => {
  it('accepts exact failures and rejects ordinary or malformed lookalikes', () => {
    const failures: unknown[] = [];
    try {
      createCompilerTaskOperationSemantics('construct' as never);
    } catch (error) {
      failures.push(error);
    }
    expect(failures).toHaveLength(1);
    expect(failures.every(isCompilerTaskOperationSemanticsFailure)).toBe(true);
    for (const value of [
      undefined,
      new Error('ordinary'),
      Object.assign(new Error('lookalike'), { kind: 'compiler-task-operation-semantics' }),
      Object.assign(new Error('lookalike'), {
        code: 'unknown',
        kind: 'compiler-task-operation-semantics',
        received: 'construct',
      }),
      Object.assign(new Error('lookalike'), {
        code: 'unknown-operation',
        kind: 'compiler-task-operation-semantics',
      }),
      Object.assign(new Error('lookalike'), {
        code: 'unknown-operation',
        kind: 'compiler-task-operation-semantics',
        received: 1,
      }),
      Object.assign(new Error('lookalike'), {
        code: 'unknown-operation',
        kind: 'compiler-task-operation-semantics',
        received: '',
      }),
    ]) {
      expect(isCompilerTaskOperationSemanticsFailure(value)).toBe(false);
    }
  });
});
