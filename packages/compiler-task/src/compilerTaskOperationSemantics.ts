import type {
  CompilerTaskOperationName,
  CompilerTaskOperationSemantics,
  CompilerTaskOperationSemanticsFailure,
  CompilerTaskOperationSemanticsFailureCode,
} from '../../compiler-types/src/index.js';

export function createCompilerTaskOperationSemantics(
  operation: CompilerTaskOperationName,
): CompilerTaskOperationSemantics {
  switch (operation) {
    case 'catch':
      return Object.freeze({
        equivalent: 'then-with-missing-fulfillment-handler',
        operation,
        schema: 'flight-compiler-task-operation-semantics/1',
      });
    case 'finally':
      return Object.freeze({
        continuation: 'enqueue-after-source-settlement',
        derivedTask: 'always-new',
        handlerArguments: 'none',
        handlerFailure: 'replace-with-rejection',
        handlerResult: 'normalize-and-ignore-fulfillment-value',
        handlerThis: 'undefined',
        nonCallableHandler: 'forward-source-settlement',
        operation,
        schema: 'flight-compiler-task-operation-semantics/1',
        sourceSettlement: 'preserve-after-handler-fulfillment',
        taskCreation: 'before-handler-registration',
      });
    case 'joinAll':
      return Object.freeze({
        elementResolution: 'normalize-value-task-or-thenable',
        emptyInput: 'resolve-empty-list',
        fulfillment: 'ordered-values-after-all-fulfill',
        iteration: 'get-iterator-once-consume-in-order',
        iterationFailure: 'reject',
        iteratorClose: 'on-abrupt-iteration',
        operation,
        rejection: 'first-observed-rejection',
        schema: 'flight-compiler-task-operation-semantics/1',
        taskCreation: 'before-iteration',
      });
    case 'ready':
      return Object.freeze({
        inputObservation: 'once',
        operation,
        schema: 'flight-compiler-task-operation-semantics/1',
        selfResolution: 'reject-type-error',
        settlement: 'normalize-value-task-or-thenable',
        settlementRace: 'first-call-wins',
        taskIdentity: 'reuse-compatible-task-otherwise-new',
        thenableFailure: 'reject-if-get-or-call-throws-before-settlement',
        thenableMethod: 'get-once-call-once',
      });
    case 'reject':
      return Object.freeze({
        operation,
        reasonObservation: 'once',
        schema: 'flight-compiler-task-operation-semantics/1',
        settlement: 'reject-exact-reason-without-assimilation',
        taskCreation: 'before-reason-observation',
      });
    case 'then':
      return Object.freeze({
        continuation: 'enqueue-after-source-settlement',
        derivedTask: 'always-new',
        fulfillmentHandlerArgument: 'source-value',
        fulfillmentHandler: 'normalize-return-reject-on-throw',
        handlerThis: 'undefined',
        missingFulfillmentHandler: 'forward-fulfillment',
        missingRejectionHandler: 'forward-rejection',
        nonCallableHandler: 'treat-as-missing',
        operation,
        rejectionHandlerArgument: 'source-reason',
        rejectionHandler: 'normalize-return-reject-on-throw',
        schema: 'flight-compiler-task-operation-semantics/1',
        taskCreation: 'before-handler-registration',
      });
    default:
      throw createCompilerTaskOperationSemanticsFailure(getCompilerTaskOperationReceived(operation));
  }
}

export function isCompilerTaskOperationSemanticsFailure(
  value: unknown,
): value is CompilerTaskOperationSemanticsFailure {
  return (
    value instanceof Error &&
    'kind' in value &&
    value.kind === 'compiler-task-operation-semantics' &&
    'code' in value &&
    compilerTaskOperationSemanticsFailureCodes.has(value.code as CompilerTaskOperationSemanticsFailureCode) &&
    'received' in value &&
    typeof value.received === 'string' &&
    value.received.length > 0
  );
}

function createCompilerTaskOperationSemanticsFailure(received: string): CompilerTaskOperationSemanticsFailure {
  const failure = Object.assign(new Error(`Unknown target-neutral task operation: ${received}`), {
    code: 'unknown-operation' as const,
    kind: 'compiler-task-operation-semantics' as const,
    received,
  });
  failure.name = 'CompilerTaskOperationSemanticsError';
  return failure;
}

function getCompilerTaskOperationReceived(operation: never): string {
  return typeof operation === 'string' ? operation : typeof operation;
}

const compilerTaskOperationSemanticsFailureCodes = new Set<CompilerTaskOperationSemanticsFailureCode>([
  'unknown-operation',
]);
