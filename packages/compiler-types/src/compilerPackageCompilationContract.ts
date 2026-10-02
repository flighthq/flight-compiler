import type ts from 'typescript';

import type { BackendCompilation, BackendEmissionFailureCode, CompilerBackend } from './compilerBackendContract.js';
import type { CompilerDiagnostic, CompilerDiagnosticCode } from './compilerDiagnosticContract.js';
import type { CompilerEmittedSourceParser } from './compilerEmittedSourceSyntaxContract.js';
import type { CompilerInvariantCode } from './compilerInvariantContract.js';
import type {
  CompilerModuleEvaluationFailureCode,
  CompilerModuleEvaluationPlan,
  CompilerModuleLinkDependency,
} from './compilerModuleEvaluationContract.js';
import type { CompilerModuleFacadePlan } from './compilerModuleFacadeContract.js';
import type { CompilerModuleResolutionPlan } from './compilerModuleResolutionContract.js';
import type { CompilerRefusalClassification } from './compilerRefusalClassificationContract.js';
import type { CompilerRuntimeAbiManifest } from './compilerRuntimeContract.js';
import type { PatchAudit, SemanticPatch } from './compilerSemanticPatchContract.js';
import type { CompilerModuleIdentity } from './compilerSourceIdentity.js';
import type { CompilerTargetCompilationSmoke } from './compilerTargetCompilationSmokeContract.js';
import type { CompilerTypeScriptAnalysisIdentity } from './compilerTypeScriptContract.js';

export interface CompilerPackageGraphPackage {
  readonly dependencies: readonly string[];
  readonly name: string;
  readonly root: string;
}

export interface CompilerPackageGraph {
  readonly entries: readonly CompilerModuleIdentity[];
  readonly moduleDependencies: readonly CompilerModuleLinkDependency[];
  readonly packages: readonly CompilerPackageGraphPackage[];
  readonly schema: 'flight-compiler-package-graph/1';
}

export type CompilerPackageGraphFailureCode =
  | 'duplicate-entry'
  | 'duplicate-package'
  | 'invalid-entry'
  | 'invalid-graph'
  | 'invalid-module-dependency'
  | 'invalid-package'
  | 'invalid-package-dependency'
  | 'invalid-source'
  | 'package-root-mismatch'
  | 'unknown-package';

export interface CompilerPackageGraphFailure extends Error {
  readonly code: CompilerPackageGraphFailureCode;
  readonly kind: 'compiler-package-graph';
  readonly subject: string;
}

export interface TypeScriptPackageGraphSource {
  readonly packageName: string;
  readonly packageRoot: string;
  readonly sourceFile: ts.SourceFile;
  readonly upstreamDirectory: string;
}

export interface CompileTypeScriptPackageGraphOptions<BackendOptions> {
  readonly backend: CompilerBackend<BackendOptions>;
  /**
   * Emit everything that lowered, including modules whose dependency refused, and write a replaceable
   * placeholder at the path of every module refused for its own reasons. Off by default: a run without it
   * produces exactly the dependency-closed output it always has.
   */
  readonly bestEffort?: boolean | undefined;
  /**
   * Restrict which modules are EMITTED, by portable source-path prefix; every module is still lowered, so a
   * selected module resolves the types it imports from an unselected one. Absent or empty emits everything.
   *
   * This scopes a run's OUTPUT, not its analysis: a module outside the prefixes produces no file and no
   * placeholder, and is reported as `skipped` rather than as a failure. It is the way to generate a subtree at a
   * time -- useful on a corpus large enough that one run is hard to watch.
   */
  readonly emitPathPrefixes?: readonly string[] | undefined;
  readonly backendOptions: Readonly<BackendOptions>;
  readonly graph: Readonly<CompilerPackageGraph>;
  readonly moduleResolution?: Readonly<CompilerModuleResolutionPlan> | undefined;
  /** Synchronous, opt-in progress for diagnosing a long-running package-graph compilation. */
  readonly observeProgress?: ((progress: Readonly<CompilerPackageCompilationProgress>) => void) | undefined;
  readonly patches?: readonly SemanticPatch[] | undefined;
  readonly sourceParser?: Readonly<CompilerEmittedSourceParser> | undefined;
  readonly sources: readonly TypeScriptPackageGraphSource[];
  readonly targetCompilationSmoke?: Readonly<CompilerTargetCompilationSmoke> | undefined;
}

/**
 * A bounded synchronous trace: two lowering-phase events, two events per source lowered, two session
 * events, then two events per module that reaches emission. A started event is delivered before the
 * named work begins, so the last event identifies the phase or module in progress without adding clocks
 * or machine state to compiler output.
 */
export type CompilerPackageCompilationProgress =
  | Readonly<{
      moduleCount: number;
      phase: 'emission-session' | 'lowering';
      schema: 'flight-compiler-package-compilation-progress/1';
      state: 'completed' | 'started';
    }>
  | Readonly<{
      completedModules: number;
      module: CompilerModuleIdentity;
      moduleCount: number;
      phase: 'module-lowering';
      schema: 'flight-compiler-package-compilation-progress/1';
      state: 'completed' | 'started';
    }>
  | Readonly<{
      completedModules: number;
      module: CompilerModuleIdentity;
      moduleCount: number;
      phase: 'module-emission';
      schema: 'flight-compiler-package-compilation-progress/1';
      state: 'started';
    }>
  | Readonly<{
      completedModules: number;
      module: CompilerModuleIdentity;
      moduleCount: number;
      outcome: 'emitted' | 'refused';
      phase: 'module-emission';
      schema: 'flight-compiler-package-compilation-progress/1';
      state: 'completed';
    }>;

export type CompilerPackageCompilationRefusalCode =
  | BackendEmissionFailureCode
  | CompilerDiagnosticCode
  | CompilerInvariantCode
  | CompilerModuleEvaluationFailureCode
  | 'dependency-refused'
  | 'internal-error';

export interface CompilerPackageCompilationRefusal {
  /** Producer-owned attribution for a direct refusal; dependency cascades inherit their direct findings. */
  readonly classification?: CompilerRefusalClassification | undefined;
  readonly code: CompilerPackageCompilationRefusalCode;
  readonly column?: number | undefined;
  readonly line?: number | undefined;
  readonly message: string;
  /**
   * Every refused dependency that blocked this module, as `<package>/<source>`, sorted. Present only
   * on `dependency-refused`. Its message names the one dependency that made the module refused,
   * because one is enough to decide the outcome; this names all of them, because a consumer ranking
   * refusal rules by the work they unblock has to know the whole set and not the first edge a scan
   * reached.
   */
  readonly refusedDependencies?: readonly string[] | undefined;
  /**
   * The stable identity of the decision this refusal records, when `message` is not one. Group by
   * `rule ?? message`: a message that embeds instance data describes one decision in as many
   * spellings as it has instances, and only the rule joins them.
   */
  readonly rule?: string | undefined;
  readonly stage: 'dependency' | 'emission' | 'initialization' | 'lowering';
}

export interface CompilerPackageCompilationFileReport {
  readonly dependencies: readonly string[];
  readonly module: CompilerModuleIdentity;
  readonly path: string;
}

export interface CompilerPackageCompilationModuleReport {
  readonly module: CompilerModuleIdentity;
  readonly outputFiles: readonly string[];
  readonly refusals: readonly CompilerPackageCompilationRefusal[];
  /**
   * `skipped` means the run's emit-path filter did not select this module: it was lowered and it is not refused,
   * it simply was not asked for, which is a different thing from a module that failed.
   */
  readonly status: 'emitted' | 'refused' | 'skipped';
}

export interface CompilerPackageCompilationPackageReport {
  readonly dependencies: readonly string[];
  readonly modules: readonly CompilerPackageCompilationModuleReport[];
  readonly name: string;
  readonly outputFiles: readonly string[];
}

/**
 * How one module fared in a best-effort run.
 *
 * `dependency-incomplete` means the module emitted its own real output and only an inherited refusal keeps it
 * out of a dependency-closed set; `refused-placeholder` means the module was refused for its own reasons and
 * the file at `path` is a replaceable stub rather than output. `path` is present whenever a file exists at
 * that path, which in best-effort mode is every module the backend could name one for.
 */
export interface CompilerPackageCompilationBestEffortModule {
  readonly classification?: CompilerRefusalClassification | undefined;
  /**
   * Every module that imports this one, as `package/source` subjects, sorted. A hand-written replacement has
   * to satisfy these callers, and they are also what a pin-to-pin report counts when this module is blocked.
   */
  readonly consumers: readonly string[];
  /**
   * The source fingerprints of this module's declarations, sorted, present only while the module is a
   * placeholder. A declaration added, removed, or edited between pins changes this list, which is how an
   * overlay notices that the module it replaces has moved underneath it.
   */
  readonly declarationFingerprints?: readonly string[] | undefined;
  readonly module: CompilerModuleIdentity;
  readonly path?: string | undefined;
  readonly refusedDependencies?: readonly string[] | undefined;
  readonly rule?: string | undefined;
  readonly status: 'dependency-incomplete' | 'emitted' | 'refused-placeholder';
}

export interface CompilerPackageCompilationBestEffortManifest {
  readonly modules: readonly CompilerPackageCompilationBestEffortModule[];
  readonly schema: 'flight-compiler-best-effort/1';
}

export interface CompilerPackageCompilationReport {
  readonly backend: string;
  /** Present only when the run requested best-effort generation. */
  readonly bestEffort?: CompilerPackageCompilationBestEffortManifest | undefined;
  readonly entries: readonly CompilerModuleIdentity[];
  /** Compiler-resolved public lanes and routes for every successfully emitted entry module. */
  readonly exports: CompilerModuleFacadePlan;
  readonly files: readonly CompilerPackageCompilationFileReport[];
  readonly initialization: CompilerModuleEvaluationPlan;
  readonly modules: readonly CompilerPackageCompilationModuleReport[];
  readonly packages: readonly CompilerPackageCompilationPackageReport[];
  readonly runtimeAbi?: CompilerRuntimeAbiManifest | undefined;
  readonly schema: 'flight-compiler-package-report/1';
  readonly typescript: CompilerTypeScriptAnalysisIdentity;
}

export interface CompilerPackageCompilationResult {
  readonly compilation: BackendCompilation;
  readonly diagnostics: readonly CompilerDiagnostic[];
  readonly patchAudit: PatchAudit;
  readonly report: CompilerPackageCompilationReport;
}
