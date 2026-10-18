import type {
  CompilerBackendModuleFile,
  CompilerBackendPackageGraphFinalization,
  EmittedFile,
} from './compilerBackendContract.js';
import type { IrModule } from './compilerModuleIntermediateRepresentation.js';
import type { CompilerModuleResolutionPlan } from './compilerModuleResolutionContract.js';
import type { CompilerRustModuleEvaluationEmissionFragment } from './compilerRustModuleEvaluationEmissionContract.js';
import type {
  CompilerRustSourceTreeFilePlan,
  CompilerRustSourceTreePlan,
  CompilerRustSourceTreeReferencePlan,
} from './compilerRustSourceTreePlanContract.js';

export interface CompilerRustSourceTreeFinalizationRequest {
  readonly finalization: CompilerBackendPackageGraphFinalization;
  /**
   * Finalizes target evidence against the one canonical source-tree plan and returns independently
   * addressable source fragments for exact placement. Declaration source remains owned by each file plan.
   */
  readonly finalizePlan?: CompilerRustSourceTreePlanFinalizer | undefined;
  readonly moduleResolution?: CompilerModuleResolutionPlan | undefined;
  readonly reemitModule: CompilerRustSourceTreeModuleReemitter;
  /** Semantic lookup for the session; only exact identities retained by `finalization.moduleFiles` are selected. */
  readonly semanticModules: readonly IrModule[];
}

export type CompilerRustSourceTreeFinalizationFailureCode =
  | 'rust-source-tree-finalization-duplicate-retained-module'
  | 'rust-source-tree-finalization-emission-target-duplicate'
  | 'rust-source-tree-finalization-emission-target-missing'
  | 'rust-source-tree-finalization-emission-target-ownership-mismatch'
  | 'rust-source-tree-finalization-emission-target-path-mismatch'
  | 'rust-source-tree-finalization-invalid-fragment-placement'
  | 'rust-source-tree-finalization-missing-retained-module'
  | 'rust-source-tree-finalization-module-file-mismatch'
  | 'rust-source-tree-finalization-placeholder-retained';

export interface CompilerRustSourceTreeFinalizationFailure extends Error {
  readonly code: CompilerRustSourceTreeFinalizationFailureCode;
  readonly kind: 'rust-source-tree-finalization';
  readonly subjects: readonly string[];
}

export interface CompilerRustSourceTreeModuleReemissionRequest {
  readonly module: IrModule;
  readonly plan: CompilerRustSourceTreePlan;
  readonly references: readonly CompilerRustSourceTreeReferencePlan[];
  readonly retainedFile: CompilerBackendModuleFile;
  readonly sourceFile: CompilerRustSourceTreeFilePlan;
}

export type CompilerRustSourceTreeModuleReemitter = (
  request: Readonly<CompilerRustSourceTreeModuleReemissionRequest>,
) => EmittedFile;

export type CompilerRustSourceTreePlanFinalizer = (
  plan: Readonly<CompilerRustSourceTreePlan>,
) => readonly Readonly<CompilerRustModuleEvaluationEmissionFragment>[] | undefined;
