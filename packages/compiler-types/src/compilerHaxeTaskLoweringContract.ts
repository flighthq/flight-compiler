import type {
  CompilerAsyncStateMachineFulfillment,
  CompilerAsyncStateMachineRefusal,
  CompilerAsyncStateMachineStateIdentity,
} from './compilerAsyncStateMachineContract.js';
import type { CompilerAsyncTaskLexicalOrigin } from './compilerAsyncTaskInventoryContract.js';
import type { IrBindingIdentity } from './compilerBindingIntermediateRepresentation.js';
import type { CompilerClosureCaptureEvidence } from './compilerClosureEvidenceContract.js';
import type { CompilerRuntimeTaskCapabilityName } from './compilerRuntimeTaskCapabilityContract.js';
import type { CompilerModuleIdentity } from './compilerSourceIdentity.js';
import type { CompilerIrTraversalPath } from './compilerTraversalObserverContract.js';
import type {
  CompilerCompletionValueSource,
  CompilerValueCompletionPathSet,
} from './compilerValueCompletionContract.js';

export interface CompilerHaxeTaskLoweringRuntime {
  readonly cleanupMemberName: string;
  readonly continueMemberName: string;
  readonly executorParameters: readonly ['resolve', 'reject'];
  readonly joinAllMemberName: string;
  readonly normalizeMemberName: string;
  readonly rejectMemberName: string;
  readonly taskTypeName: string;
}

export interface CompilerHaxeTaskLoweringOptions {
  readonly runtimeModule?: string | undefined;
}

export interface CompilerHaxeTaskLoweringStrategy {
  readonly continuation: 'nested-callback-chain';
  readonly retainedBindings: 'lexical-closure-storage';
  readonly retainedCaptures: 'lexical-closure-storage';
  readonly settlement: 'executor-resolve-reject-callbacks';
  readonly taskConstruction: 'runtime-constructor-executor';
  readonly thisBinding: 'lexical';
}

export type CompilerHaxeTaskLoweringStep =
  | Readonly<{
      abruptValues: readonly CompilerCompletionValueSource[];
      kind: 'executeSource';
      onAbrupt: 'rejectTask';
      path: CompilerIrTraversalPath;
    }>
  | Readonly<{
      fulfillment: CompilerAsyncStateMachineFulfillment;
      kind: 'awaitRuntime';
      operandPath: CompilerIrTraversalPath;
      path: CompilerIrTraversalPath;
      rejection: CompilerCompletionValueSource;
      resumeState?: CompilerAsyncStateMachineStateIdentity | undefined;
    }>
  | Readonly<{
      evaluationRejection?: CompilerCompletionValueSource | undefined;
      kind: 'rejectTask' | 'resolveTask';
      path: CompilerIrTraversalPath;
      value: CompilerCompletionValueSource;
    }>
  | Readonly<{
      conditionPath: CompilerIrTraversalPath;
      evaluationRejection: CompilerCompletionValueSource;
      kind: 'branchState';
      path: CompilerIrTraversalPath;
      whenFalse: CompilerAsyncStateMachineStateIdentity;
      whenTrue: CompilerAsyncStateMachineStateIdentity;
    }>
  | Readonly<{
      kind: 'continueState';
      path: CompilerIrTraversalPath;
      target: CompilerAsyncStateMachineStateIdentity;
    }>
  | Readonly<{
      header: CompilerAsyncStateMachineStateIdentity;
      kind: 'loopState';
      path: CompilerIrTraversalPath;
    }>;

export interface CompilerHaxeTaskLoweringState {
  readonly identity: CompilerAsyncStateMachineStateIdentity;
  readonly steps: readonly CompilerHaxeTaskLoweringStep[];
}

export interface CompilerHaxeTaskLoweringRetainedBinding {
  readonly binding: IrBindingIdentity;
  readonly declarationPath: CompilerIrTraversalPath;
  readonly storage: 'lexicalClosure';
  readonly suspensionPaths: readonly CompilerIrTraversalPath[];
}

export type CompilerHaxeTaskLoweringRetainedCapture = CompilerClosureCaptureEvidence &
  Readonly<{ storage: 'lexicalClosure' }>;

export interface CompilerHaxeTaskLoweringFunction {
  readonly completionPaths: CompilerValueCompletionPathSet;
  readonly origin: CompilerAsyncTaskLexicalOrigin;
  readonly path: CompilerIrTraversalPath;
  readonly retainedBindings: readonly CompilerHaxeTaskLoweringRetainedBinding[];
  readonly retainedCaptures: readonly CompilerHaxeTaskLoweringRetainedCapture[];
  readonly states: readonly CompilerHaxeTaskLoweringState[];
}

export interface CompilerHaxeTaskLoweringRefusal {
  readonly code: CompilerAsyncStateMachineRefusal['code'];
  readonly kind: 'neutralStateMachine';
  readonly path: CompilerIrTraversalPath;
  readonly scopePath: CompilerIrTraversalPath;
}

export interface CompilerHaxeTaskLowering {
  readonly functions: readonly CompilerHaxeTaskLoweringFunction[];
  readonly module: CompilerModuleIdentity;
  readonly refusals: readonly CompilerHaxeTaskLoweringRefusal[];
  readonly runtime: CompilerHaxeTaskLoweringRuntime;
  readonly schema: 'flight-compiler-haxe-task-lowering/1';
  readonly strategy: CompilerHaxeTaskLoweringStrategy;
}

export type CompilerHaxeTaskLoweringFailureCode =
  | 'runtime-capability-incomplete'
  | 'runtime-member-name'
  | 'runtime-task-type-name';

export interface CompilerHaxeTaskLoweringFailure extends Error {
  readonly capability?: CompilerRuntimeTaskCapabilityName | undefined;
  readonly code: CompilerHaxeTaskLoweringFailureCode;
  readonly kind: 'haxe-task-lowering';
  readonly module: CompilerModuleIdentity;
  readonly received?: string | undefined;
}
