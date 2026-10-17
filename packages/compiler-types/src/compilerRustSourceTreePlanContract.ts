import type { CompilerModuleFacadePlan } from './compilerModuleFacadeContract.js';
import type { IrModule } from './compilerModuleIntermediateRepresentation.js';
import type { CompilerModuleResolutionPlan } from './compilerModuleResolutionContract.js';
import type { CompilerModuleIdentity } from './compilerSourceIdentity.js';

export interface CompilerRustSourceTreeModuleDeclaration {
  readonly modulePath: readonly string[];
  readonly name: string;
  readonly visibility: 'private' | 'public';
}

export type CompilerRustSourceTreeFileOwnership =
  | Readonly<{ kind: 'source'; module: CompilerModuleIdentity }>
  | Readonly<{ kind: 'skeleton'; provenance: readonly CompilerModuleIdentity[] }>;

export interface CompilerRustSourceTreeFilePlan {
  readonly declarations: readonly CompilerRustSourceTreeModuleDeclaration[];
  readonly filePath: string;
  readonly modulePath: readonly string[];
  readonly ownership: CompilerRustSourceTreeFileOwnership;
  readonly packageName: string;
  /** Declaration-only Rust source to prepend to source-owned files or emit as a skeleton body. */
  readonly sourceFragment: string;
}

export interface CompilerRustSourceTreeModulePlan {
  readonly filePath: string;
  readonly identity: CompilerModuleIdentity;
  readonly modulePath: readonly string[];
}

export interface CompilerRustSourceTreeReferencePlan {
  readonly from: CompilerModuleIdentity;
  readonly importedNames?: readonly string[] | undefined;
  readonly rustPath: string;
  readonly specifier: string;
  readonly target: CompilerModuleIdentity;
}

export interface CompilerRustSourceTreePlan {
  readonly files: readonly CompilerRustSourceTreeFilePlan[];
  readonly modules: readonly CompilerRustSourceTreeModulePlan[];
  readonly references: readonly CompilerRustSourceTreeReferencePlan[];
  readonly schema: 'flight-rust-source-tree-plan/1';
}

export interface CompilerRustSourceTreePlanInput {
  readonly facade: CompilerModuleFacadePlan;
  readonly moduleResolution?: CompilerModuleResolutionPlan | undefined;
  readonly modules: readonly Readonly<IrModule>[];
  /**
   * Modules the run looked at but deliberately left out of `modules`, with the reason. Import resolution
   * consults it only to attribute a request that names no retained module; it never selects a target.
   */
  readonly unavailableModules?: readonly CompilerRustSourceTreeUnavailableModule[] | undefined;
}

/**
 * Why a module is absent from the retained set. `refused` carries the producer's reason, `unselected`
 * records a module outside the requested emit paths.
 */
export type CompilerRustSourceTreeUnavailableModule =
  | Readonly<{
      code: string;
      disposition: 'refused';
      message: string;
      module: CompilerModuleIdentity;
    }>
  | Readonly<{ disposition: 'unselected'; module: CompilerModuleIdentity }>;

export type CompilerRustSourceTreePlanningFailureCode =
  | 'rust-source-tree-crate-collision'
  | 'rust-source-tree-file-collision'
  | 'rust-source-tree-import-ambiguity'
  | 'rust-source-tree-import-target-absent'
  | 'rust-source-tree-import-target-refused'
  | 'rust-source-tree-import-target-unselected'
  | 'rust-source-tree-module-collision'
  | 'rust-source-tree-public-module-missing';

export interface CompilerRustSourceTreePlanningFailure extends Error {
  readonly code: CompilerRustSourceTreePlanningFailureCode;
  readonly kind: 'rust-source-tree-planning';
  readonly subjects: readonly string[];
}
