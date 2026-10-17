import type { CompilerModuleFacadeHop, CompilerModuleFacadePlan } from './compilerModuleFacadeContract.js';
import type { IrModule } from './compilerModuleIntermediateRepresentation.js';
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

export interface CompilerRustPublicBindingPlan {
  readonly bindings: readonly CompilerRustPublicBinding[];
  readonly crates: readonly CompilerRustPublicCrateIdentity[];
  readonly dependencies: readonly CompilerRustPublicDependencyEdge[];
  readonly modules: readonly CompilerRustPublicModulePlan[];
  readonly schema: 'flight-rust-public-binding-plan/2';
}

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

export type CompilerRustPublicBindingPlanningFailureCode =
  | 'rust-public-binding-collision'
  | 'rust-public-crate-collision'
  | 'rust-public-module-collision';

export interface CompilerRustPublicBindingPlanningFailure extends Error {
  readonly code: CompilerRustPublicBindingPlanningFailureCode;
  readonly kind: 'rust-public-binding-planning';
  readonly subjects: readonly string[];
}
