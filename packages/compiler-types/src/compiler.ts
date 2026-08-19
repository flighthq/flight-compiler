import type ts from 'typescript';

import type { BackendCompilation, CompilerBackend } from './backend.js';
import type { LowerTypeScriptSourceOptions } from './typescript.js';
import type { CompilerDiagnostic, IrModule } from './ir.js';
import type { PatchAudit, SemanticPatch } from './patch.js';

export interface CompileModulesOptions<BackendOptions> {
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

export interface CompileModulesResult {
  compilation: BackendCompilation;
  diagnostics: CompilerDiagnostic[];
  patchAudit: PatchAudit;
  report: CompilerReport;
}

export interface CompilerDiagnosticsFailure extends Error {
  diagnostics: readonly CompilerDiagnostic[];
  kind: 'compiler-diagnostics';
}

export interface TypeScriptModuleInput extends LowerTypeScriptSourceOptions {
  sourceFile: ts.SourceFile;
}

export interface CompileTypeScriptModulesOptions<BackendOptions> extends Omit<
  CompileModulesOptions<BackendOptions>,
  'modules'
> {
  sources: readonly TypeScriptModuleInput[];
}
