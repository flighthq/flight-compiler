import type { IrBindingIdentity } from './compilerBindingIntermediateRepresentation.js';
import type { IrModule } from './compilerModuleIntermediateRepresentation.js';
import type { CompilerModuleResolutionPlan } from './compilerModuleResolutionContract.js';
import type { CompilerModuleIdentity } from './compilerSourceIdentity.js';

export type CompilerRustReferenceRepresentation = 'mutable-borrowed-vec' | 'shared-ref-cell-vec';

export interface CompilerRustReferenceParameterPlan {
  readonly position: number;
  readonly representation: CompilerRustReferenceRepresentation;
}

export interface CompilerRustReferenceCallablePlan {
  /** The binding visible in this module: a declaration for local calls or an import for external calls. */
  readonly binding: IrBindingIdentity;
  readonly parameters: readonly CompilerRustReferenceParameterPlan[];
}

export type CompilerRustReferenceRepresentationRefusalCode =
  | 'rust-reference-array-call-target-ambiguous'
  | 'rust-reference-array-call-target-unresolved'
  | 'rust-reference-array-argument-unrepresented'
  | 'rust-reference-mutating-parameter-unrepresented'
  | 'rust-reference-shared-array-alias-ambiguous'
  | 'rust-reference-shared-array-binding-reassignment-unrepresented'
  | 'rust-reference-shared-array-borrow-conflict'
  | 'rust-reference-shared-array-closure-escape-unrepresented'
  | 'rust-reference-shared-array-suspension-unrepresented'
  | 'rust-reference-shared-array-use-unrepresented';

export interface CompilerRustReferenceRepresentationRefusal {
  readonly code: CompilerRustReferenceRepresentationRefusalCode;
  readonly message: string;
  readonly subject: string;
}

export interface CompilerRustReferenceModulePlan {
  readonly callables: readonly CompilerRustReferenceCallablePlan[];
  readonly module: CompilerModuleIdentity;
  /** Bindings whose array referent is mutated locally or by a planned callee. */
  readonly referentMutatedBindings: readonly IrBindingIdentity[];
  readonly refusals: readonly CompilerRustReferenceRepresentationRefusal[];
  /** Local array aliases represented by one single-threaded shared RefCell carrier. */
  readonly sharedArrayBindings: readonly Readonly<{
    binding: IrBindingIdentity;
    representation: Extract<CompilerRustReferenceRepresentation, 'shared-ref-cell-vec'>;
  }>[];
}

export interface CompilerRustReferenceRepresentationPlan {
  readonly modules: readonly CompilerRustReferenceModulePlan[];
  readonly schema: 'flight-rust-reference-representation-plan/1';
}

export interface CompilerRustReferenceRepresentationPlanInput {
  readonly moduleResolution?: Readonly<CompilerModuleResolutionPlan> | undefined;
  readonly modules: readonly Readonly<IrModule>[];
}
