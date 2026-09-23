import type { CompilerModuleResolutionPlan } from './compilerModuleResolutionContract.js';
import type {
  CompileTypeScriptPackageGraphOptions,
  CompilerPackageCompilationResult,
  CompilerPackageGraph,
  TypeScriptPackageGraphSource,
} from './compilerPackageCompilationContract.js';
import type { WorkspaceSource } from './compilerWorkspaceSourceContract.js';

export interface CreateFlightWorkspaceCompilationInputOptions {
  /** The complete package closure selected by target-neutral manifest policy. */
  readonly eligiblePackageNames: readonly string[];
  readonly packageScope?: string | undefined;
  readonly packagesDirectory?: string | undefined;
  /** Absent means the host filesystem. */
  readonly source?: WorkspaceSource | undefined;
  readonly upstreamDirectory: string;
}

export type CompileFlightWorkspaceOptions<BackendOptions> = CreateFlightWorkspaceCompilationInputOptions &
  Omit<CompileTypeScriptPackageGraphOptions<BackendOptions>, 'graph' | 'moduleResolution' | 'sources'>;

export interface FlightWorkspaceCompilationInput {
  readonly graph: CompilerPackageGraph;
  readonly moduleResolution: CompilerModuleResolutionPlan;
  readonly sources: readonly TypeScriptPackageGraphSource[];
}

export type FlightWorkspaceCompilationFailureCode =
  | 'duplicate-eligible-package'
  | 'empty-eligible-package-set'
  | 'incomplete-package-closure'
  | 'invalid-source-path'
  | 'missing-package-sources'
  | 'unknown-eligible-package'
  | 'unresolved-export-source'
  | 'unresolved-import';

export interface FlightWorkspaceCompilationFailure extends Error {
  readonly code: FlightWorkspaceCompilationFailureCode;
  readonly kind: 'flight-workspace-compilation';
  readonly subject: string;
}

export type FlightWorkspaceCompilationResult = CompilerPackageCompilationResult;
