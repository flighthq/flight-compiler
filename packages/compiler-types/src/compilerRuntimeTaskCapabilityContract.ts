import type { CompilerAsyncTaskOperationIdentity } from './compilerAsyncTaskInventoryContract.js';
import type { CompilerModuleIdentity } from './compilerSourceIdentity.js';
import type { CompilerIrTraversalPath } from './compilerTraversalObserverContract.js';

export type CompilerRuntimeTaskCapabilityContractVersion = 'flight-runtime-task-capability-abi/1';

export type CompilerRuntimeTaskCapabilityName =
  | 'cleanup'
  | 'construct'
  | 'continue'
  | 'joinAll'
  | 'normalize'
  | 'reject';

interface CompilerRuntimeTaskCapabilityCommon {
  readonly capability: CompilerRuntimeTaskCapabilityName;
}

interface CompilerRuntimeTaskMemberCapabilityCommon extends CompilerRuntimeTaskCapabilityCommon {
  readonly memberName: string;
}

export type CompilerRuntimeTaskCapability =
  | (CompilerRuntimeTaskCapabilityCommon &
      Readonly<{
        capability: 'construct';
        completionSemantics: 'flight-compiler-async-task-completion/1';
        executorInvocation: 'synchronous';
        executorParameters: readonly ['resolve', 'reject'];
        invocation: 'constructor';
        settlementCallbacks: 'first-call-wins-assimilating-resolve-exact-reject';
      }>)
  | (CompilerRuntimeTaskMemberCapabilityCommon &
      Readonly<{
        awaitSemantics: 'flight-compiler-await-semantics/1';
        capability: 'continue';
        invocation: 'instanceMethod';
        operation: 'then';
        operationSemantics: 'flight-compiler-task-operation-semantics/1';
      }>)
  | (CompilerRuntimeTaskMemberCapabilityCommon &
      Readonly<{
        capability: 'cleanup';
        invocation: 'instanceMethod';
        operation: 'finally';
        operationSemantics: 'flight-compiler-task-operation-semantics/1';
      }>)
  | (CompilerRuntimeTaskMemberCapabilityCommon &
      Readonly<{
        capability: 'joinAll';
        invocation: 'staticMethod';
        operation: 'joinAll';
        operationSemantics: 'flight-compiler-task-operation-semantics/1';
      }>)
  | (CompilerRuntimeTaskMemberCapabilityCommon &
      Readonly<{
        capability: 'normalize';
        invocation: 'staticMethod';
        operation: 'ready';
        operationSemantics: 'flight-compiler-task-operation-semantics/1';
      }>)
  | (CompilerRuntimeTaskMemberCapabilityCommon &
      Readonly<{
        capability: 'reject';
        invocation: 'staticMethod';
        operation: 'reject';
        operationSemantics: 'flight-compiler-task-operation-semantics/1';
      }>);

export interface CompilerRuntimeTaskCapabilityPlan {
  readonly capabilities: readonly CompilerRuntimeTaskCapability[];
  readonly contract: CompilerRuntimeTaskCapabilityContractVersion;
}

export type CompilerRuntimeTaskCapabilityRequirementEvidence =
  | Readonly<{
      kind: 'stateMachine';
      path: CompilerIrTraversalPath;
      reason: 'assimilation' | 'construction' | 'continuation';
    }>
  | Readonly<{
      kind: 'taskOperation';
      operation: CompilerAsyncTaskOperationIdentity['operation'];
      path: CompilerIrTraversalPath;
    }>;

export interface CompilerRuntimeTaskCapabilityRequirement {
  readonly capability: CompilerRuntimeTaskCapabilityName;
  readonly evidence: readonly CompilerRuntimeTaskCapabilityRequirementEvidence[];
}

export interface CompilerRuntimeTaskCapabilityRequirements {
  readonly module: CompilerModuleIdentity;
  readonly requirements: readonly CompilerRuntimeTaskCapabilityRequirement[];
  readonly schema: 'flight-runtime-task-capability-requirements/1';
}

export type CompilerRuntimeTaskCapabilityCompleteness =
  | Readonly<{
      capabilities: readonly CompilerRuntimeTaskCapability[];
      contract: CompilerRuntimeTaskCapabilityContractVersion;
      kind: 'complete';
      requirements: CompilerRuntimeTaskCapabilityRequirements;
      schema: 'flight-runtime-task-capability-completeness/1';
    }>
  | Readonly<{
      capabilities: readonly CompilerRuntimeTaskCapability[];
      contract: CompilerRuntimeTaskCapabilityContractVersion;
      duplicateCapabilities: readonly CompilerRuntimeTaskCapabilityName[];
      invalidCapabilities: readonly CompilerRuntimeTaskCapabilityName[];
      kind: 'incomplete';
      missingCapabilities: readonly CompilerRuntimeTaskCapabilityName[];
      requirements: CompilerRuntimeTaskCapabilityRequirements;
      schema: 'flight-runtime-task-capability-completeness/1';
    }>;

export interface CompilerRuntimeTaskCapabilityAnalysisMismatchFailure extends Error {
  readonly code: 'module-identity';
  readonly kind: 'runtime-task-capability-analysis-mismatch';
  readonly stateMachineModule: CompilerModuleIdentity;
  readonly taskInventoryModule: CompilerModuleIdentity;
}

export interface CompilerRuntimeTaskCapabilityContractMismatchFailure extends Error {
  readonly expected: CompilerRuntimeTaskCapabilityContractVersion;
  readonly kind: 'runtime-task-capability-contract-mismatch';
  readonly received: string;
}
