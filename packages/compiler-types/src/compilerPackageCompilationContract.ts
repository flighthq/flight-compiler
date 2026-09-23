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
  readonly backendOptions: Readonly<BackendOptions>;
  readonly graph: Readonly<CompilerPackageGraph>;
  readonly moduleResolution?: Readonly<CompilerModuleResolutionPlan> | undefined;
  readonly patches?: readonly SemanticPatch[] | undefined;
  readonly sourceParser?: Readonly<CompilerEmittedSourceParser> | undefined;
  readonly sources: readonly TypeScriptPackageGraphSource[];
  readonly targetCompilationSmoke?: Readonly<CompilerTargetCompilationSmoke> | undefined;
}

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
  readonly status: 'emitted' | 'refused';
}

export interface CompilerPackageCompilationPackageReport {
  readonly dependencies: readonly string[];
  readonly modules: readonly CompilerPackageCompilationModuleReport[];
  readonly name: string;
  readonly outputFiles: readonly string[];
}

export interface CompilerPackageCompilationReport {
  readonly backend: string;
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
