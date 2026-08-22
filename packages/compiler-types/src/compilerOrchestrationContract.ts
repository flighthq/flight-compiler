import type ts from 'typescript';

import type { BackendCompilation, CompilerBackend } from './compilerBackendContract.js';
import type { CompilerDiagnostic } from './compilerDiagnosticContract.js';
import type { CompilerEmittedSourceParser } from './compilerEmittedSourceSyntaxContract.js';
import type { IrModule } from './compilerModuleIntermediateRepresentation.js';
import type { CompilerModuleResolutionPlan } from './compilerModuleResolutionContract.js';
import type { PatchAudit, SemanticPatch } from './compilerSemanticPatchContract.js';
import type { CompilerTargetCompilationSmoke } from './compilerTargetCompilationSmokeContract.js';
import type { LowerTypeScriptSourceOptions } from './compilerTypeScriptContract.js';

export interface CompileIrModulesOptions<BackendOptions> {
  readonly backend: CompilerBackend<BackendOptions>;
  readonly backendOptions: Readonly<BackendOptions>;
  readonly moduleResolution?: Readonly<CompilerModuleResolutionPlan> | undefined;
  readonly modules: readonly IrModule[];
  readonly patches?: readonly SemanticPatch[] | undefined;
  /** Optional syntax-only parser over normalized emitted files. */
  readonly sourceParser?: Readonly<CompilerEmittedSourceParser> | undefined;
  /** Optional downstream target compiler over the complete normalized emitted file set. */
  readonly targetCompilationSmoke?: Readonly<CompilerTargetCompilationSmoke> | undefined;
}

export interface CompilerReport {
  readonly backend: string;
  readonly emittedFiles: number;
  readonly modules: number;
  readonly schema: 'flight-compiler-report/1';
}

export interface CompileIrModulesResult {
  readonly compilation: BackendCompilation;
  readonly diagnostics: readonly CompilerDiagnostic[];
  readonly patchAudit: PatchAudit;
  readonly report: CompilerReport;
}

export interface CompilerDiagnosticsFailure extends Error {
  readonly diagnostics: readonly CompilerDiagnostic[];
  readonly kind: 'compiler-diagnostics';
}

export interface TypeScriptModuleInput extends LowerTypeScriptSourceOptions {
  readonly sourceFile: ts.SourceFile;
}

export interface CompileTypeScriptModulesOptions<BackendOptions> extends Omit<
  CompileIrModulesOptions<BackendOptions>,
  'modules'
> {
  readonly sources: readonly TypeScriptModuleInput[];
}
