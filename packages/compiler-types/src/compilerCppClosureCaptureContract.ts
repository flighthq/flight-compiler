import type { IrBindingIdentity } from './compilerBindingIntermediateRepresentation.js';
import type { CompilerClosureCaptureLifetimeBoundary } from './compilerClosureEvidenceContract.js';
import type { CompilerIrTraversalPath } from './compilerTraversalObserverContract.js';

export type CompilerCppClosureCaptureAccess = 'bindingRead' | 'bindingReassignment' | 'referentMutation';

export type CompilerCppClosureCaptureOwnership = 'closureValue' | 'moduleStorage' | 'sharedBindingStorage';

export type CompilerCppClosureCaptureReason =
  | 'capturedBindingMutation'
  | 'capturedMutableBinding'
  | 'capturedReferentMutation'
  | 'moduleLifetime'
  | 'outsideMutation'
  | 'valueSnapshot';

export type CompilerCppClosureCaptureRepresentation = 'directModuleBinding' | 'sharedMutableCell' | 'valueCopy';

export interface CompilerCppClosureCaptureBindingPlan {
  readonly accesses: readonly CompilerCppClosureCaptureAccess[];
  readonly binding: IrBindingIdentity;
  readonly declarationPath: CompilerIrTraversalPath;
  readonly lifetimeBoundaries: readonly CompilerClosureCaptureLifetimeBoundary[];
  readonly ownership: CompilerCppClosureCaptureOwnership;
  readonly reasons: readonly CompilerCppClosureCaptureReason[];
  readonly representation: CompilerCppClosureCaptureRepresentation;
}

export interface CompilerCppClosureCapturePlan {
  readonly bindings: readonly CompilerCppClosureCaptureBindingPlan[];
  readonly schema: 'flight-compiler-cpp-closure-capture-plan/2';
}
