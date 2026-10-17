import type {
  CompilerBackendModuleFile,
  CompilerBackendPackageGraphFinalization,
  EmittedFile,
} from './compilerBackendContract.js';
import type { IrModule } from './compilerModuleIntermediateRepresentation.js';
import type { CompilerModuleResolutionPlan } from './compilerModuleResolutionContract.js';
import type {
  CompilerRustSourceTreeFilePlan,
  CompilerRustSourceTreePlan,
  CompilerRustSourceTreeReferencePlan,
} from './compilerRustSourceTreePlanContract.js';

export interface CompilerRustSourceTreeFinalizationRequest {
  readonly finalization: CompilerBackendPackageGraphFinalization;
  readonly moduleResolution?: CompilerModuleResolutionPlan | undefined;
  /**
   * Receives the one canonical plan before any module is re-emitted. A session uses it to cache the
   * exact planned path of every module that will receive a refusal placeholder, so the placeholder file
   * and the source tree cannot disagree about where a module lives.
   */
  readonly observePlan?: ((plan: Readonly<CompilerRustSourceTreePlan>) => void) | undefined;
  readonly reemitModule: CompilerRustSourceTreeModuleReemitter;
  /** Semantic lookup for the session; only exact identities retained by `finalization.moduleFiles` are selected. */
  readonly semanticModules: readonly IrModule[];
}

export type CompilerRustSourceTreeFinalizationFailureCode =
  | 'rust-source-tree-finalization-duplicate-retained-module'
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
