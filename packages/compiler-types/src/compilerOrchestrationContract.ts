import type ts from 'typescript';

import type { BackendCompilation, CompilerBackend } from './compilerBackendContract.js';
import type { CompilerDiagnostic, IrModule } from './compilerIntermediateRepresentation.js';
import type { PatchAudit, SemanticPatch } from './compilerSemanticPatchContract.js';
import type { LowerTypeScriptSourceOptions } from './compilerTypeScriptContract.js';

export interface CompileIrModulesOptions<BackendOptions> {
  backend: CompilerBackend<BackendOptions>;
  backendOptions: Readonly<BackendOptions>;
  modules: readonly IrModule[];
  patches?: readonly SemanticPatch[] | undefined;
}

export interface CompilerReport {
  backend: string;
  emittedFiles: number;
  modules: number;
  schema: 'flight-compiler-report/1';
}

export interface CompileIrModulesResult {
  compilation: BackendCompilation;
  diagnostics: CompilerDiagnostic[];
  patchAudit: PatchAudit;
  report: CompilerReport;
}

export interface CompilerDiagnosticsFailure extends Error {
  diagnostics: readonly CompilerDiagnostic[];
  kind: 'compiler-diagnostics';
}

export type CompilerInvariantCode = 'duplicate-emitted-path' | 'duplicate-module-identity' | 'unsafe-emitted-path';

export interface CompilerInvariantFailure extends Error {
  code: CompilerInvariantCode;
  kind: 'compiler-invariant';
  subject: string;
}

export interface TypeScriptModuleInput extends LowerTypeScriptSourceOptions {
  sourceFile: ts.SourceFile;
}

export interface CompileTypeScriptModulesOptions<BackendOptions> extends Omit<
  CompileIrModulesOptions<BackendOptions>,
  'modules'
> {
  sources: readonly TypeScriptModuleInput[];
}
