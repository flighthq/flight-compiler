import type { CppCompilerPackageTarget } from './compilerBackendContract.js';
import type { CompilerModuleResolutionPlan } from './compilerModuleResolutionContract.js';
import type { CompilerRefusalClassification } from './compilerRefusalClassificationContract.js';

export type CompilerCppCAbiAdapterConversion =
  | 'borrow-handle'
  | 'borrow-readonly-handle'
  | 'copy-scalar-from-c'
  | 'copy-scalar-to-out'
  | 'create-owned-handle-to-out'
  | 'none';

export type CompilerCppCAbiDiagnosticCode =
  | 'ambiguous-owner'
  | 'callable-value'
  | 'dual-sentinel-union'
  | 'generic-surface'
  | 'global-symbol-collision'
  | 'open-structural-type'
  | 'overloaded-function'
  | 'unsupported-carrier'
  | 'unsupported-parameter';

export type CompilerCppCAbiEmissionFailureCode = 'ambiguous-lifecycle' | 'invalid-plan' | 'unsupported-carrier';

export type CompilerCppCAbiOwnership = 'borrowed' | 'none' | 'owned' | 'value';

export type CompilerCppCAbiPresence = 'nullable-null' | 'nullable-undefined' | 'not-applicable' | 'required';

export interface CompilerCppCAbiDiagnostic {
  readonly bindingId: string;
  readonly classification: CompilerRefusalClassification;
  readonly code: CompilerCppCAbiDiagnosticCode;
  readonly kind: 'cpp-c-abi';
  readonly message: string;
  readonly packageName: string;
  readonly source: string;
  readonly sourceName: string;
  readonly target: 'cpp';
}

export interface CompilerCppCAbiErrorPlan {
  readonly catchesCppExceptions: true;
  readonly exceptionConstant: 'FLIGHT_CPP_STATUS_EXCEPTION';
  readonly initializesOutResultBeforeValidation: true;
  readonly invalidArgumentConstant: 'FLIGHT_CPP_STATUS_INVALID_ARGUMENT';
  readonly lastError: 'none';
  readonly statusCarrier: 'flight_cpp_status';
  readonly strategy: 'status-return';
  readonly successConstant: 'FLIGHT_CPP_STATUS_OK';
}

export interface CompilerCppCAbiEmission {
  readonly functions: readonly CompilerCppCAbiFunctionEmission[];
  readonly handles: readonly CompilerCppCAbiHandleEmission[];
  readonly schema: 'flight-compiler-cpp-c-abi-emission/1';
}

export interface CompilerCppCAbiEmissionFailure extends Error {
  readonly bindingId: string;
  readonly code: CompilerCppCAbiEmissionFailureCode;
  readonly kind: 'cpp-c-abi-emission';
  readonly packageName: string;
  readonly source: string;
  readonly symbol: string;
}

export interface CompilerCppCAbiFunctionPlan {
  readonly bindingId: string;
  readonly cppTarget: string;
  readonly error: CompilerCppCAbiErrorPlan;
  readonly header: string;
  readonly packageName: string;
  readonly parameters: readonly CompilerCppCAbiParameterPlan[];
  readonly result: CompilerCppCAbiResultPlan;
  readonly source: string;
  readonly sourceName: string;
  readonly symbol: string;
  readonly visibility: 'FLIGHT_CPP_API';
}

export interface CompilerCppCAbiFunctionEmission {
  readonly adapterSourceContents: string;
  readonly bindingId: string;
  readonly headerContents: string;
  readonly headerPath: string;
  readonly packageName: string;
  readonly source: string;
  readonly symbol: string;
}

export interface CompilerCppCAbiHandleEmission {
  readonly adapterSourceContents: string;
  readonly bindingId: string;
  readonly carrier: string;
  readonly headerContents: string;
  readonly headerPath: string;
  readonly packageName: string;
  readonly releaseSymbol: string;
  readonly retainSymbol: string;
  readonly source: string;
}

export interface CompilerCppCAbiHandlePlan {
  readonly bindingId: string;
  readonly borrowSymbol: string;
  readonly carrier: string;
  readonly cppOwnerCarrier: string;
  readonly cppTarget: string;
  readonly createOwnedSymbol: string;
  readonly header: string;
  readonly lifecycle: Readonly<{
    borrowedInput: 'const-owner-reference';
    counter: 'atomic-wrapper-reference-count';
    initialReferences: 1;
    nullOwnedOutput: 'null-handle';
    nullRelease: 'no-op';
    nullRetain: 'return-null';
    ownedOutput: 'move-owner-into-new-wrapper';
    retainedResult: 'same-handle';
    zeroReferences: 'delete-wrapper';
  }>;
  readonly ownership: 'opaque-reference';
  readonly packageName: string;
  readonly releaseSymbol: string;
  readonly retainSymbol: string;
  readonly source: string;
  readonly sourceName: string;
}

export type CompilerCppCAbiParameterPlan =
  | Readonly<{
      adapter: 'borrow-handle' | 'borrow-readonly-handle';
      carrier: string;
      handleCarrier: string;
      name: string;
      ownership: 'borrowed';
      position: number;
      presence: Exclude<CompilerCppCAbiPresence, 'not-applicable'>;
    }>
  | Readonly<{
      adapter: 'copy-scalar-from-c';
      carrier: string;
      name: string;
      ownership: 'value';
      position: number;
      presence: 'required';
    }>;

export type CompilerCppCAbiResultPlan =
  | Readonly<{
      adapter: 'none';
      kind: 'void';
      ownership: 'none';
      presence: 'not-applicable';
    }>
  | Readonly<{
      adapter: 'copy-scalar-to-out';
      carrier: string;
      initialization: 'zero';
      kind: 'out';
      name: 'out_result';
      ownership: 'value';
      presence: Exclude<CompilerCppCAbiPresence, 'not-applicable'>;
    }>
  | Readonly<{
      adapter: 'create-owned-handle-to-out';
      carrier: string;
      handleCarrier: string;
      initialization: 'null';
      kind: 'out';
      name: 'out_result';
      ownership: 'owned';
      presence: Exclude<CompilerCppCAbiPresence, 'not-applicable'>;
    }>;

export interface CompilerCppCAbiPlan {
  readonly diagnostics: readonly CompilerCppCAbiDiagnostic[];
  readonly functions: readonly CompilerCppCAbiFunctionPlan[];
  readonly handles: readonly CompilerCppCAbiHandlePlan[];
  readonly policy: Readonly<{
    error: 'status-plus-initialized-out-result';
    exportPrefix: 'flight_cpp_';
    lastError: 'none';
    lifecycle: 'type-specific-retain-release';
    references: 'incomplete-c-struct-pointers';
    visibility: 'FLIGHT_CPP_API';
  }>;
  readonly schema: 'flight-compiler-cpp-c-abi-plan/1';
}

export interface CompilerCppCAbiPlanningOptions {
  readonly moduleResolution?: Readonly<CompilerModuleResolutionPlan> | undefined;
  readonly packageTargets?: Readonly<Record<string, Readonly<CppCompilerPackageTarget>>> | undefined;
}
