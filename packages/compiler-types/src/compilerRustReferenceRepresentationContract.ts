import type { IrBindingIdentity } from './compilerBindingIntermediateRepresentation.js';
import type { IrModule } from './compilerModuleIntermediateRepresentation.js';
import type { CompilerModuleResolutionPlan } from './compilerModuleResolutionContract.js';
import type { CompilerModuleIdentity } from './compilerSourceIdentity.js';

export type CompilerRustReferenceRepresentation =
  | 'borrowed-class'
  | 'mutable-borrowed-class'
  | 'mutable-borrowed-hash-map'
  | 'mutable-borrowed-hash-set'
  | 'mutable-borrowed-vec'
  | 'optional-null-shared-ref-cell-class'
  | 'optional-undefined-shared-ref-cell-class'
  | 'shared-ref-cell-class'
  | 'shared-ref-cell-hash-map'
  | 'shared-ref-cell-hash-set'
  | 'shared-ref-cell-vec';

export interface CompilerRustReferenceParameterPlan {
  readonly position: number;
  readonly representation: CompilerRustReferenceRepresentation;
}

export interface CompilerRustReferenceCallablePlan {
  /** The binding visible in this module: a declaration for local calls or an import for external calls. */
  readonly binding: IrBindingIdentity;
  readonly parameters: readonly CompilerRustReferenceParameterPlan[];
  readonly returns?:
    | Extract<
        CompilerRustReferenceRepresentation,
        'optional-null-shared-ref-cell-class' | 'optional-undefined-shared-ref-cell-class' | 'shared-ref-cell-class'
      >
    | undefined;
}

export interface CompilerRustSharedArrayTupleComponentPlan {
  readonly position: number;
  readonly representation: Extract<CompilerRustReferenceRepresentation, 'shared-ref-cell-vec'>;
}

export interface CompilerRustSharedArrayTupleBindingPlan {
  readonly binding: IrBindingIdentity;
  readonly components: readonly CompilerRustSharedArrayTupleComponentPlan[];
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
  | 'rust-reference-shared-array-tuple-abi-unrepresented'
  | 'rust-reference-shared-array-tuple-flow-unrepresented'
  | 'rust-reference-shared-array-tuple-shape-unrepresented'
  | 'rust-reference-shared-array-use-unrepresented'
  | 'rust-reference-shared-class-alias-ambiguous'
  | 'rust-reference-shared-class-binding-reassignment-unrepresented'
  | 'rust-reference-shared-class-borrow-conflict'
  | 'rust-reference-shared-class-call-unrepresented'
  | 'rust-reference-shared-class-closure-escape-unrepresented'
  | 'rust-reference-shared-class-construction-unrepresented'
  | 'rust-reference-shared-class-field-unrepresented'
  | 'rust-reference-shared-class-identity-unrepresented'
  | 'rust-reference-shared-class-member-unrepresented'
  | 'rust-reference-shared-class-mutator-result-unrepresented'
  | 'rust-reference-shared-class-return-unrepresented'
  | 'rust-reference-shared-class-suspension-unrepresented'
  | 'rust-reference-shared-class-type-unrepresented'
  | 'rust-reference-shared-class-use-unrepresented'
  | 'rust-async-method-body-unrepresented'
  | 'rust-async-method-call-unrepresented'
  | 'rust-async-method-owner-carrier-unrepresented'
  | 'rust-reference-shared-map-alias-ambiguous'
  | 'rust-reference-shared-map-binding-reassignment-unrepresented'
  | 'rust-reference-shared-map-borrow-conflict'
  | 'rust-reference-shared-map-call-unrepresented'
  | 'rust-reference-shared-map-closure-escape-unrepresented'
  | 'rust-reference-shared-map-key-unrepresented'
  | 'rust-reference-shared-map-mutator-result-unrepresented'
  | 'rust-reference-shared-map-suspension-unrepresented'
  | 'rust-reference-shared-map-use-unrepresented'
  | 'rust-reference-shared-map-value-unrepresented'
  | 'rust-reference-shared-set-alias-ambiguous'
  | 'rust-reference-shared-set-binding-reassignment-unrepresented'
  | 'rust-reference-shared-set-borrow-conflict'
  | 'rust-reference-shared-set-call-unrepresented'
  | 'rust-reference-shared-set-closure-escape-unrepresented'
  | 'rust-reference-shared-set-element-unrepresented'
  | 'rust-reference-shared-set-mutator-result-unrepresented'
  | 'rust-reference-shared-set-suspension-unrepresented'
  | 'rust-reference-shared-set-use-unrepresented';

export interface CompilerRustReferenceRepresentationRefusal {
  readonly code: CompilerRustReferenceRepresentationRefusalCode;
  readonly message: string;
  readonly subject: string;
}

export interface CompilerRustReferenceModulePlan {
  readonly callables: readonly CompilerRustReferenceCallablePlan[];
  readonly module: CompilerModuleIdentity;
  /** Bindings whose reference referent is mutated locally or by a planned callee. */
  readonly referentMutatedBindings: readonly IrBindingIdentity[];
  readonly refusals: readonly CompilerRustReferenceRepresentationRefusal[];
  /** Local array aliases represented by one single-threaded shared RefCell carrier. */
  readonly sharedArrayBindings: readonly Readonly<{
    binding: IrBindingIdentity;
    representation: Extract<CompilerRustReferenceRepresentation, 'shared-ref-cell-vec'>;
  }>[];
  /** Local fixed array tuples whose elements each require one shared RefCell Vec carrier. */
  readonly sharedArrayTupleBindings: readonly CompilerRustSharedArrayTupleBindingPlan[];
  /** Local simple-class aliases represented by one single-threaded shared RefCell carrier. */
  readonly sharedClassBindings: readonly Readonly<{
    binding: IrBindingIdentity;
    representation: Extract<
      CompilerRustReferenceRepresentation,
      'optional-null-shared-ref-cell-class' | 'optional-undefined-shared-ref-cell-class' | 'shared-ref-cell-class'
    >;
  }>[];
  /** Local Map aliases represented by one single-threaded shared RefCell carrier. */
  readonly sharedMapBindings: readonly Readonly<{
    binding: IrBindingIdentity;
    representation: Extract<CompilerRustReferenceRepresentation, 'shared-ref-cell-hash-map'>;
  }>[];
  /** Local Set aliases represented by one single-threaded shared RefCell carrier. */
  readonly sharedSetBindings: readonly Readonly<{
    binding: IrBindingIdentity;
    representation: Extract<CompilerRustReferenceRepresentation, 'shared-ref-cell-hash-set'>;
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
