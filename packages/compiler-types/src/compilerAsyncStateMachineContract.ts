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
  | Readonly<{ arm: 'whenFalse' | 'whenTrue'; kind: 'branchArm'; path: CompilerIrTraversalPath }>
  | Readonly<{ kind: 'entry' }>
  | Readonly<{ kind: 'catch'; path: CompilerIrTraversalPath }>
  | Readonly<{ kind: 'join'; path: CompilerIrTraversalPath }>
  | Readonly<{ kind: 'loopHeader'; path: CompilerIrTraversalPath }>
  | Readonly<{ kind: 'resume'; suspensionPath: CompilerIrTraversalPath }>;

// States otherwise fall through to the one after them, the way basic blocks are laid out in order.
// A branch ends its state with two named successors, and a `goto` ends one with a single named
// successor, which is what lets an arm skip the arm laid out after it.
export interface CompilerAsyncStateMachineBranchStep {
  readonly conditionPath: CompilerIrTraversalPath;
  readonly evaluationRejection: CompilerCompletionValueSource;
  readonly kind: 'branch';
  readonly path: CompilerIrTraversalPath;
  readonly whenFalse: CompilerAsyncStateMachineStateIdentity;
  readonly whenTrue: CompilerAsyncStateMachineStateIdentity;
}

export interface CompilerAsyncStateMachineGotoStep {
  readonly kind: 'goto';
  readonly path: CompilerIrTraversalPath;
  readonly target: CompilerAsyncStateMachineStateIdentity;
}

// A guarded region: its body runs with a handler in scope, and both the body and the handler leave
// through the same join.
export interface CompilerAsyncStateMachineGuardStep {
  readonly body: CompilerAsyncStateMachineStateIdentity;
  readonly catchState: CompilerAsyncStateMachineStateIdentity;
  readonly join: CompilerAsyncStateMachineStateIdentity;
  readonly kind: 'guard';
  readonly path: CompilerIrTraversalPath;
}

// A loop is the one shape whose continuation runs more than once, so its header is named where the
// loop begins and re-entered by the back edge at the end of the body.
export interface CompilerAsyncStateMachineLoopStep {
  readonly header: CompilerAsyncStateMachineStateIdentity;
  readonly kind: 'loop';
  readonly path: CompilerIrTraversalPath;
}

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
  // Where a rejection goes. Absent, it settles the task; present, it enters a source-level handler,
  // which is what a `try` around the suspension means.
  readonly rejectState?: CompilerAsyncStateMachineStateIdentity | undefined;
  readonly resumeState?: CompilerAsyncStateMachineStateIdentity | undefined;
}

// A state whose synchronous throws belong to a source handler rather than to the task settlement.
export interface CompilerAsyncStateMachineGuardedState {
  readonly catchBinding?: IrBindingIdentity | undefined;
  readonly catchState: CompilerAsyncStateMachineStateIdentity;
  // A `finally` handler does not consume the rejection it runs on: it runs and then lets the same
  // rejection continue. A `catch` handler does consume it.
  readonly rethrow?: boolean | undefined;
}

export interface CompilerAsyncStateMachineSettleStep {
  readonly evaluationRejection?: CompilerCompletionValueSource | undefined;
  readonly kind: 'reject' | 'resolve';
  readonly path: CompilerIrTraversalPath;
  readonly value: CompilerCompletionValueSource;
}

export type CompilerAsyncStateMachineStep =
  | CompilerAsyncStateMachineBranchStep
  | CompilerAsyncStateMachineExecuteStep
  | CompilerAsyncStateMachineGotoStep
  | CompilerAsyncStateMachineGuardStep
  | CompilerAsyncStateMachineLoopStep
  | CompilerAsyncStateMachineSettleStep
  | CompilerAsyncStateMachineSuspendStep;

export interface CompilerAsyncStateMachineState {
  readonly guard?: CompilerAsyncStateMachineGuardedState | undefined;
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
