import type { BackendCompilation, CompilerBackend } from './backend.ts';
import type { CompilerDiagnostic, IrModule } from './ir.ts';
import type { PatchAudit, SemanticPatch } from './patch.ts';

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
