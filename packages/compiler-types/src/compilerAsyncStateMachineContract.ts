import type { CompilerAsyncTaskLexicalOrigin } from './compilerAsyncTaskInventoryContract.js';
import type { IrBindingIdentity } from './compilerBindingIntermediateRepresentation.js';
import type { CompilerClosureCaptureEvidence } from './compilerClosureEvidenceContract.js';
import type { CompilerModuleIdentity } from './compilerSourceIdentity.js';
import type { CompilerIrTraversalPath } from './compilerTraversalObserverContract.js';
import type {
  CompilerCompletionValueSource,
  CompilerValueCompletionPathSet,
} from './compilerValueCompletionContract.js';

export type CompilerAsyncStateMachineStateIdentity =
  | Readonly<{ kind: 'entry' }>
  | Readonly<{ kind: 'resume'; suspensionPath: CompilerIrTraversalPath }>;

export interface CompilerAsyncStateMachineExecuteStep {
  readonly abruptValues: readonly CompilerCompletionValueSource[];
  readonly kind: 'execute';
  readonly path: CompilerIrTraversalPath;
}

export type CompilerAsyncStateMachineFulfillment =
  | Readonly<{ kind: 'discard' }>
  | Readonly<{ binding: IrBindingIdentity; kind: 'initializeBinding' }>
  | Readonly<{ binding: IrBindingIdentity; kind: 'rebind' }>
  | Readonly<{ kind: 'resolve'; value: CompilerCompletionValueSource }>;

export interface CompilerAsyncStateMachineSuspendStep {
  readonly fulfillment: CompilerAsyncStateMachineFulfillment;
  readonly kind: 'suspend';
  readonly operandPath: CompilerIrTraversalPath;
  readonly path: CompilerIrTraversalPath;
  readonly rejection: CompilerCompletionValueSource;
  readonly resumeState?: CompilerAsyncStateMachineStateIdentity | undefined;
}

export interface CompilerAsyncStateMachineSettleStep {
  readonly evaluationRejection?: CompilerCompletionValueSource | undefined;
  readonly kind: 'reject' | 'resolve';
  readonly path: CompilerIrTraversalPath;
  readonly value: CompilerCompletionValueSource;
}

export type CompilerAsyncStateMachineStep =
  | CompilerAsyncStateMachineExecuteStep
  | CompilerAsyncStateMachineSettleStep
  | CompilerAsyncStateMachineSuspendStep;

export interface CompilerAsyncStateMachineState {
  readonly identity: CompilerAsyncStateMachineStateIdentity;
  readonly steps: readonly CompilerAsyncStateMachineStep[];
}

export interface CompilerAsyncStateMachineRetainedBinding {
  readonly binding: IrBindingIdentity;
  readonly declarationPath: CompilerIrTraversalPath;
  readonly suspensionPaths: readonly CompilerIrTraversalPath[];
}

export interface CompilerAsyncStateMachine {
  readonly completionPaths: CompilerValueCompletionPathSet;
  readonly origin: CompilerAsyncTaskLexicalOrigin;
  readonly path: CompilerIrTraversalPath;
  readonly retainedBindings: readonly CompilerAsyncStateMachineRetainedBinding[];
  readonly retainedCaptures: readonly CompilerClosureCaptureEvidence[];
  readonly states: readonly CompilerAsyncStateMachineState[];
}

export type CompilerAsyncStateMachineRefusalCode =
  | 'escaping-control-flow'
  | 'unreachable-statement'
  | 'unsupported-async-iteration'
  | 'unsupported-control-flow'
  | 'unsupported-suspension-expression';

export interface CompilerAsyncStateMachineRefusal {
  readonly code: CompilerAsyncStateMachineRefusalCode;
  readonly path: CompilerIrTraversalPath;
  readonly scopePath: CompilerIrTraversalPath;
}

export interface CompilerAsyncStateMachineAnalysis {
  readonly machines: readonly CompilerAsyncStateMachine[];
  readonly module: CompilerModuleIdentity;
  readonly refusals: readonly CompilerAsyncStateMachineRefusal[];
  readonly schema: 'flight-compiler-async-state-machine-analysis/1';
}
