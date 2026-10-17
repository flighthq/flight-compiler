import type { CompilerBackendPackageGraphFinalization } from './compilerBackendContract.js';
import type { IrBindingIdentity } from './compilerBindingIntermediateRepresentation.js';
import type {
  CompilerModuleEvaluationBinding,
  CompilerModuleEvaluationDependency,
  CompilerModuleEvaluationSemantics,
  CompilerModuleEvaluationStep,
} from './compilerModuleEvaluationContract.js';
import type { CompilerModuleFacadeSlot } from './compilerModuleFacadeContract.js';
import type { IrModule } from './compilerModuleIntermediateRepresentation.js';
import type {
  CompilerRustModuleConstantBindingPlan,
  CompilerRustModuleConstantPlan,
} from './compilerRustModuleConstantContract.js';
import type {
  CompilerRustModuleStateBindingPlan,
  CompilerRustModuleStatePlan,
} from './compilerRustModuleStateContract.js';
import type {
  CompilerRustReferenceRepresentation,
  CompilerRustReferenceRepresentationPlan,
} from './compilerRustReferenceRepresentationContract.js';
import type { CompilerRustSourceTreePlan } from './compilerRustSourceTreePlanContract.js';
import type { CompilerModuleIdentity } from './compilerSourceIdentity.js';
import type { CompilerIrTraversalPath } from './compilerTraversalObserverContract.js';

export interface CompilerRustModuleEvaluationLocator {
  readonly filePath: string;
  readonly modulePath: readonly string[];
  readonly packageName: string;
}

export type CompilerRustModuleEvaluationRepresentationRefusalCode =
  | 'rust-module-evaluation-abrupt-completion-unrepresented'
  | 'rust-module-evaluation-binding-carrier-unrepresented'
  | 'rust-module-evaluation-cross-crate-cycle-unrepresented'
  | 'rust-module-evaluation-entry-invocation-unbound'
  | 'rust-module-evaluation-live-alias-unrepresented'
  | 'rust-module-evaluation-output-scope-incomplete'
  | 'rust-module-evaluation-salvaged-declaration'
  | 'rust-module-evaluation-step-unrepresented'
  | 'rust-module-evaluation-tdz-carrier-unrepresented';

export interface CompilerRustModuleEvaluationRepresentationRefusal {
  readonly binding?: IrBindingIdentity | undefined;
  readonly code: CompilerRustModuleEvaluationRepresentationRefusalCode;
  readonly detailCode?: string | undefined;
  readonly group?: readonly CompilerModuleIdentity[] | undefined;
  readonly message: string;
  readonly module?: CompilerModuleIdentity | undefined;
  readonly path?: CompilerIrTraversalPath | undefined;
  readonly subject: string;
}

export type CompilerRustModuleEvaluationBindingStorage =
  | Readonly<{ kind: 'function-item' }>
  | Readonly<{
      evidence: CompilerRustModuleConstantBindingPlan;
      kind: 'primitive-constant';
    }>
  | Readonly<{
      evidence: CompilerRustModuleStateBindingPlan;
      kind: 'private-scalar-state';
    }>
  | Readonly<{
      kind: 'reference-carrier';
      representation: CompilerRustReferenceRepresentation;
    }>
  | Readonly<{ kind: 'unrepresented' }>;

export type CompilerRustModuleEvaluationBindingDecision =
  | Readonly<{
      outcome: 'erased';
      reason: 'function-item' | 'primitive-constant' | 'private-scalar-state';
    }>
  | Readonly<{
      outcome: 'refused';
      refusals: readonly CompilerRustModuleEvaluationRepresentationRefusal[];
    }>;

export interface CompilerRustModuleEvaluationLocalBindingPlan {
  readonly access: Extract<CompilerModuleEvaluationBinding, { kind: 'local' }>['access'];
  readonly binding: IrBindingIdentity;
  readonly decision: CompilerRustModuleEvaluationBindingDecision;
  readonly initialization: Extract<CompilerModuleEvaluationBinding, { kind: 'local' }>['initialization'];
  readonly kind: 'local';
  readonly mutation: Extract<CompilerModuleEvaluationBinding, { kind: 'local' }>['mutation'];
  readonly storage: CompilerRustModuleEvaluationBindingStorage;
}

export type CompilerRustModuleEvaluationImportAliasDecision =
  | Readonly<{
      outcome: 'erased';
      reason: 'immutable-primitive-constant';
    }>
  | Readonly<{
      outcome: 'refused';
      refusals: readonly CompilerRustModuleEvaluationRepresentationRefusal[];
    }>;

export interface CompilerRustModuleEvaluationImportAliasPlan {
  readonly access: 'dependency-live';
  readonly binding: IrBindingIdentity;
  readonly decision: CompilerRustModuleEvaluationImportAliasDecision;
  readonly imported: string;
  readonly kind: 'import';
  readonly mutation: 'read-only';
  readonly provider: CompilerModuleFacadeSlot;
  readonly request: Readonly<{
    readonly module: CompilerModuleIdentity;
  }>;
}

export type CompilerRustModuleEvaluationBindingRepresentationPlan =
  | CompilerRustModuleEvaluationImportAliasPlan
  | CompilerRustModuleEvaluationLocalBindingPlan;

export type CompilerRustModuleEvaluationStepOutcome =
  | Readonly<{
      evidence: readonly Readonly<{
        bindingId: string;
        kind: 'primitive-constant' | 'private-scalar-state';
      }>[];
      outcome: 'erased';
    }>
  | Readonly<{
      lifecycle: 'evaluate';
      outcome: 'driver';
    }>
  | Readonly<{
      outcome: 'refused';
      refusals: readonly CompilerRustModuleEvaluationRepresentationRefusal[];
    }>;

export interface CompilerRustModuleEvaluationStepPlan {
  readonly index: number;
  readonly outcome: CompilerRustModuleEvaluationStepOutcome;
  /** Exact authoritative neutral evidence; no target reconstruction is permitted. */
  readonly provenance: CompilerModuleEvaluationStep;
}

export interface CompilerRustModuleEvaluationLifecycleSymbolIntents {
  readonly evaluate: 'module-private-evaluate-once-function';
  readonly instantiate: 'module-private-instantiate-once-function';
  readonly state: 'module-private-lifecycle-state';
  readonly states: readonly ['uninstantiated', 'instantiating', 'instantiated', 'evaluating', 'evaluated', 'errored'];
}

export interface CompilerRustModuleEvaluationModuleRepresentationPlan {
  /** Exact authoritative binding order, including provider-backed import aliases. */
  readonly bindings: readonly CompilerRustModuleEvaluationBindingRepresentationPlan[];
  readonly dependencies: readonly CompilerModuleEvaluationDependency[];
  readonly lifecycle: CompilerRustModuleEvaluationLifecycleSymbolIntents;
  readonly locator: CompilerRustModuleEvaluationLocator;
  readonly module: CompilerModuleIdentity;
  readonly steps: readonly CompilerRustModuleEvaluationStepPlan[];
}

export interface CompilerRustModuleEvaluationEntryRepresentationPlan {
  readonly invocation: Readonly<{
    readonly kind: 'unbound';
    readonly refusal: CompilerRustModuleEvaluationRepresentationRefusal;
  }>;
  readonly locator: CompilerRustModuleEvaluationLocator;
  readonly module: CompilerModuleIdentity;
}

export type CompilerRustModuleEvaluationGroupRepresentation =
  | Readonly<{ kind: 'same-crate-scc'; packageName: string }>
  | Readonly<{ kind: 'single-module' }>
  | Readonly<{
      kind: 'refused';
      refusal: CompilerRustModuleEvaluationRepresentationRefusal;
    }>;

export interface CompilerRustModuleEvaluationGroupRepresentationPlan {
  readonly cyclic: boolean;
  readonly modules: readonly CompilerModuleIdentity[];
  readonly representation: CompilerRustModuleEvaluationGroupRepresentation;
}

export interface CompilerRustModuleEvaluationRepresentationEligibility {
  readonly outcome: 'eligible' | 'refused';
  readonly refusals: readonly CompilerRustModuleEvaluationRepresentationRefusal[];
  readonly scope: 'full-output';
}

export interface CompilerRustModuleEvaluationRepresentationPlan {
  readonly eligibility: CompilerRustModuleEvaluationRepresentationEligibility;
  readonly entries: readonly CompilerRustModuleEvaluationEntryRepresentationPlan[];
  readonly groups: readonly CompilerRustModuleEvaluationGroupRepresentationPlan[];
  readonly modules: readonly CompilerRustModuleEvaluationModuleRepresentationPlan[];
  readonly schema: 'flight-rust-module-evaluation-representation-plan/1';
  readonly semantics: CompilerModuleEvaluationSemantics;
}

export interface CompilerRustModuleEvaluationRepresentationPlanInput {
  readonly constantPlan: CompilerRustModuleConstantPlan;
  readonly finalization: CompilerBackendPackageGraphFinalization;
  /** Exact retained semantic modules corresponding to `finalization.moduleFiles`. */
  readonly modules: readonly Readonly<IrModule>[];
  readonly referencePlan: CompilerRustReferenceRepresentationPlan;
  readonly sourceTree: CompilerRustSourceTreePlan;
  readonly statePlan: CompilerRustModuleStatePlan;
}

export type CompilerRustModuleEvaluationRepresentationPlanningFailureCode =
  | 'rust-module-evaluation-representation-duplicate-identity'
  | 'rust-module-evaluation-representation-invalid-input'
  | 'rust-module-evaluation-representation-path-mismatch'
  | 'rust-module-evaluation-representation-projection-mismatch';

export interface CompilerRustModuleEvaluationRepresentationPlanningFailure extends Error {
  readonly code: CompilerRustModuleEvaluationRepresentationPlanningFailureCode;
  readonly kind: 'rust-module-evaluation-representation-planning';
  readonly subjects: readonly string[];
}
