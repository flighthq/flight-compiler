import type { CompilerModuleFacadeHop, CompilerModuleFacadePlan } from './compilerModuleFacadeContract.js';
import type { IrModule } from './compilerModuleIntermediateRepresentation.js';
import type { CompilerRustModuleEvaluationExecutionPlan } from './compilerRustModuleEvaluationExecutionContract.js';
import type { CompilerRustModuleEvaluationRepresentationRefusal } from './compilerRustModuleEvaluationRepresentationContract.js';
import type { CompilerModuleIdentity } from './compilerSourceIdentity.js';

export interface CompilerRustPublicCrateIdentity {
  /** Cargo package spelling. */
  readonly cargoName: string;
  readonly packageName: string;
  /** Rust path spelling used by `use` expressions. */
  readonly rustName: string;
}

export interface CompilerRustPublicModuleLocator {
  readonly crate: CompilerRustPublicCrateIdentity;
  /** Module segments below the crate root; an empty path denotes the root module. */
  readonly modulePath: readonly string[];
  readonly source: string;
}

export interface CompilerRustPublicModulePlan {
  readonly identity: CompilerModuleIdentity;
  readonly locator: CompilerRustPublicModuleLocator;
}

export interface CompilerRustPublicDependencyEdge {
  readonly from: CompilerRustPublicModuleLocator;
  readonly kind: CompilerModuleFacadeHop['kind'];
  readonly specifier: string;
  readonly target: CompilerRustPublicModuleLocator;
}

export type CompilerRustPublicBindingCarrier =
  | 'class'
  | 'enum'
  | 'function'
  | 'interface'
  | 'module'
  | 'type-alias'
  | 'value';

export type CompilerRustPublicBindingLocator =
  | Readonly<{
      carrier: Exclude<CompilerRustPublicBindingCarrier, 'module'>;
      module: CompilerRustPublicModuleLocator;
      spelling: string;
    }>
  | Readonly<{
      carrier: 'module';
      /** Module that publicly exposes the facade spelling. */
      module: CompilerRustPublicModuleLocator;
      spelling: string;
      /** Exact source module denoted by the public namespace alias. */
      target: CompilerRustPublicModuleLocator;
    }>;

export type CompilerRustPublicBindingRefusalCode =
  | 'rust-declaration-missing'
  | 'rust-module-missing'
  | 'rust-module-refused'
  | 'rust-unsupported-facade-route';

export interface CompilerRustPublicBindingRefusal {
  readonly code: CompilerRustPublicBindingRefusalCode;
  readonly detailCode?: string | undefined;
  readonly message: string;
  readonly subject: string;
}

export type CompilerRustPublicBindingAvailability =
  | Readonly<{ availability: 'available'; locator: CompilerRustPublicBindingLocator }>
  | Readonly<{ availability: 'refused'; refusal: CompilerRustPublicBindingRefusal }>;

export interface CompilerRustPublicBindingSourceExportIdentity {
  readonly declarationIdentity: string;
  readonly exportRoute: string;
  readonly packageName: string;
  readonly source: string;
  readonly space: 'type' | 'value';
}

export interface CompilerRustPublicBinding {
  readonly binding: CompilerRustPublicBindingAvailability;
  readonly facadeIdentity: string;
  readonly identity: CompilerRustPublicBindingSourceExportIdentity;
  readonly key: string;
}

export interface CompilerRustPublicBindingPlanV2 {
  readonly bindings: readonly CompilerRustPublicBinding[];
  readonly crates: readonly CompilerRustPublicCrateIdentity[];
  readonly dependencies: readonly CompilerRustPublicDependencyEdge[];
  readonly modules: readonly CompilerRustPublicModulePlan[];
  readonly schema: 'flight-rust-public-binding-plan/2';
}

// Whether a public name can be used immediately, must wait for a successful bootstrap, or is not
// safely usable because the target's initialization was refused. Type-space names never require a
// runtime bootstrap; value and module names do, because their cells exist only after evaluation.
export type CompilerRustPublicBindingAccess =
  | Readonly<{ kind: 'immediate' }>
  | Readonly<{ kind: 'after-bootstrap' }>
  | Readonly<{ kind: 'refused' }>;

export interface CompilerRustPublicBindingV3 extends CompilerRustPublicBinding {
  readonly access: CompilerRustPublicBindingAccess;
}

// The finalized executable schedule carried verbatim, or the exact reasons it could not be planned.
// Downstream owns the one global serialized bootstrap; this plan never reorders or re-derives groups.
export type CompilerRustPublicBindingInitialization =
  | Readonly<{
      availability: 'available';
      plan: CompilerRustModuleEvaluationExecutionPlan;
      required: 'before-value-access';
    }>
  | Readonly<{
      availability: 'refused';
      code: 'rust-public-binding-initialization-refused';
      refusals: readonly CompilerRustModuleEvaluationRepresentationRefusal[];
    }>;

export interface CompilerRustPublicBindingPlanV3 {
  readonly bindings: readonly CompilerRustPublicBindingV3[];
  readonly crates: readonly CompilerRustPublicCrateIdentity[];
  readonly dependencies: readonly CompilerRustPublicDependencyEdge[];
  readonly initialization: CompilerRustPublicBindingInitialization;
  readonly modules: readonly CompilerRustPublicModulePlan[];
  readonly schema: 'flight-rust-public-binding-plan/3';
}

export type CompilerRustPublicBindingPlan = CompilerRustPublicBindingPlanV2 | CompilerRustPublicBindingPlanV3;

export interface CompilerRustPublicBindingModuleRefusal {
  readonly code: string;
  readonly message: string;
  readonly module: CompilerModuleIdentity;
}

export interface CompilerRustPublicBindingPlanInput {
  readonly facade: CompilerModuleFacadePlan;
  readonly modules: readonly Readonly<IrModule>[];
  readonly refusals?: readonly Readonly<CompilerRustPublicBindingModuleRefusal>[] | undefined;
}

export interface CompilerRustPublicBindingPlanInputV3 extends CompilerRustPublicBindingPlanInput {
  /** The finalized Lane 1 schedule, carried verbatim; never re-derived here. */
  readonly execution: CompilerRustModuleEvaluationExecutionPlan;
  /** Selected runtime crate spelling, when the run named one; the execution error crate must match. */
  readonly runtimeCrate?: string | undefined;
}

export type CompilerRustPublicBindingPlanningFailureCode =
  | 'rust-public-binding-access-unrepresented'
  | 'rust-public-binding-collision'
  | 'rust-public-binding-execution-missing'
  | 'rust-public-binding-execution-projection-mismatch'
  | 'rust-public-binding-execution-schema-mismatch'
  | 'rust-public-binding-initialization-projection-mismatch'
  | 'rust-public-crate-collision'
  | 'rust-public-module-collision';

export interface CompilerRustPublicBindingPlanningFailure extends Error {
  readonly code: CompilerRustPublicBindingPlanningFailureCode;
  readonly kind: 'rust-public-binding-planning';
  readonly subjects: readonly string[];
}
