export type CompilerTaskOperationName = 'catch' | 'finally' | 'joinAll' | 'ready' | 'reject' | 'then';

interface CompilerTaskOperationSemanticsCommon {
  readonly operation: CompilerTaskOperationName;
  readonly schema: 'flight-compiler-task-operation-semantics/1';
}

export type CompilerTaskOperationSemantics =
  | (CompilerTaskOperationSemanticsCommon &
      Readonly<{
        inputObservation: 'once';
        operation: 'ready';
        selfResolution: 'reject-type-error';
        settlement: 'normalize-value-task-or-thenable';
        settlementRace: 'first-call-wins';
        taskIdentity: 'reuse-compatible-task-otherwise-new';
        thenableFailure: 'reject-if-get-or-call-throws-before-settlement';
        thenableMethod: 'get-once-call-once';
      }>)
  | (CompilerTaskOperationSemanticsCommon &
      Readonly<{
        operation: 'reject';
        reasonObservation: 'once';
        settlement: 'reject-exact-reason-without-assimilation';
        taskCreation: 'before-reason-observation';
      }>)
  | (CompilerTaskOperationSemanticsCommon &
      Readonly<{
        elementResolution: 'normalize-value-task-or-thenable';
        emptyInput: 'resolve-empty-list';
        fulfillment: 'ordered-values-after-all-fulfill';
        iteration: 'get-iterator-once-consume-in-order';
        iterationFailure: 'reject';
        iteratorClose: 'on-abrupt-iteration';
        operation: 'joinAll';
        rejection: 'first-observed-rejection';
        taskCreation: 'before-iteration';
      }>)
  | (CompilerTaskOperationSemanticsCommon &
      Readonly<{
        continuation: 'enqueue-after-source-settlement';
        derivedTask: 'always-new';
        fulfillmentHandlerArgument: 'source-value';
        fulfillmentHandler: 'normalize-return-reject-on-throw';
        handlerThis: 'undefined';
        missingFulfillmentHandler: 'forward-fulfillment';
        missingRejectionHandler: 'forward-rejection';
        nonCallableHandler: 'treat-as-missing';
        operation: 'then';
        rejectionHandlerArgument: 'source-reason';
        rejectionHandler: 'normalize-return-reject-on-throw';
        taskCreation: 'before-handler-registration';
      }>)
  | (CompilerTaskOperationSemanticsCommon &
      Readonly<{
        equivalent: 'then-with-missing-fulfillment-handler';
        operation: 'catch';
      }>)
  | (CompilerTaskOperationSemanticsCommon &
      Readonly<{
        continuation: 'enqueue-after-source-settlement';
        derivedTask: 'always-new';
        handlerArguments: 'none';
        handlerFailure: 'replace-with-rejection';
        handlerResult: 'normalize-and-ignore-fulfillment-value';
        handlerThis: 'undefined';
        nonCallableHandler: 'forward-source-settlement';
        operation: 'finally';
        sourceSettlement: 'preserve-after-handler-fulfillment';
        taskCreation: 'before-handler-registration';
      }>);

export type CompilerTaskOperationSemanticsFailureCode = 'unknown-operation';

export interface CompilerTaskOperationSemanticsFailure extends Error {
  readonly code: CompilerTaskOperationSemanticsFailureCode;
  readonly kind: 'compiler-task-operation-semantics';
  readonly received: string;
}
