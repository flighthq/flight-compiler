import type { IrBindingIdentity } from './compilerBindingIntermediateRepresentation.js';
import type { CompilerIrTraversalPath } from './compilerTraversalObserverContract.js';

export type CompilerCppClosureCaptureReason =
  | 'capturedBindingMutation'
  | 'capturedMutableBinding'
  | 'capturedReferentMutation'
  | 'moduleLifetime'
  | 'outsideMutation'
  | 'valueSnapshot';

export type CompilerCppClosureCaptureRepresentation = 'directModuleBinding' | 'sharedMutableCell' | 'valueCopy';

export interface CompilerCppClosureCaptureBindingPlan {
  readonly binding: IrBindingIdentity;
  readonly declarationPath: CompilerIrTraversalPath;
  readonly reasons: readonly CompilerCppClosureCaptureReason[];
  readonly representation: CompilerCppClosureCaptureRepresentation;
}

export interface CompilerCppClosureCapturePlan {
  readonly bindings: readonly CompilerCppClosureCaptureBindingPlan[];
  readonly schema: 'flight-compiler-cpp-closure-capture-plan/1';
}
