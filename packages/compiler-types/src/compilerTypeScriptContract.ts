import type ts from 'typescript';

import type { CompilerDiagnostic } from './compilerDiagnosticContract.js';
import type { IrModule } from './compilerModuleIntermediateRepresentation.js';
import type { CompilerRuntimeExternalSymbolBindingPlan } from './compilerRuntimeContract.js';
import type { CompilerModuleIdentity } from './compilerSourceIdentity.js';

export interface LowerTypeScriptSourceOptions {
  readonly packageName: string;
  /** Exact target-profile symbol identities available to this isolated lowering. */
  readonly profileTypeNameEvidence?: Readonly<CompilerRuntimeExternalSymbolBindingPlan> | undefined;
  readonly upstreamDirectory: string;
}

export interface LowerTypeScriptSourcesOptions {
  /** Synchronous source boundaries for diagnosing a long-running project lowering. */
  readonly observeProgress?: ((progress: Readonly<TypeScriptModuleLoweringProgress>) => void) | undefined;
  /** Exact target-profile symbol identities available to every module in this lowering run. */
  readonly profileTypeNameEvidence?: Readonly<CompilerRuntimeExternalSymbolBindingPlan> | undefined;
}

export interface RuntimeExportDecision {
  readonly declaration?: ts.Declaration | ts.SourceFile | undefined;
  readonly runtime: boolean;
}

export interface TypeScriptProject {
  readonly checker: ts.TypeChecker;
  readonly options: ts.CompilerOptions;
  readonly program: ts.Program;
}

export interface CompilerTypeScriptAnalysisIdentity {
  readonly checkerMode: 'package-graph-program';
  readonly compilerOptions: Readonly<{
    module: 'ESNext';
    moduleResolution: 'compiler-graph-with-typescript-fallback';
    noImplicitAny: true;
    standardLibrary: 'typescript-bundled';
    strictNullChecks: true;
    target: 'ESNext';
  }>;
  readonly schema: 'flight-compiler-typescript-analysis/1';
  readonly typescriptVersion: string;
}

export interface TypeScriptLoweringResult {
  readonly diagnostics: readonly CompilerDiagnostic[];
  readonly module: IrModule;
}

export interface TypeScriptModuleLoweringProgress {
  readonly completedModules: number;
  readonly module: CompilerModuleIdentity;
  readonly moduleCount: number;
  readonly state: 'completed' | 'started';
}

export interface TypeScriptInvocationSignatureResolution {
  readonly implementation: ts.SignatureDeclaration | ts.JSDocSignature;
  readonly overloadIndex?: number | undefined;
  readonly resolved: ts.SignatureDeclaration | ts.JSDocSignature;
}
