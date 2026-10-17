import type { IrModule } from './compilerModuleIntermediateRepresentation.js';
import type { CompilerModuleResolutionPlan } from './compilerModuleResolutionContract.js';
import type { CompilerModuleIdentity } from './compilerSourceIdentity.js';
import type { CompilerIrTraversalPath } from './compilerTraversalObserverContract.js';

export type CompilerRustModuleConstantScalar = 'boolean' | 'number' | 'string';

export interface CompilerRustModuleConstantBindingPlan {
  readonly bindingId: string;
  readonly capability: 'literal-string-constant' | 'primitive-const-expression';
  readonly declarationPath: CompilerIrTraversalPath;
  readonly dependencies: readonly string[];
  readonly scalar: CompilerRustModuleConstantScalar;
}

export interface CompilerRustModuleArrayImportRefusal {
  readonly bindingId: string;
  readonly code: 'rust-module-array-value-unrepresented';
  readonly importPath: CompilerIrTraversalPath;
  readonly message: string;
  readonly providerBindingId: string;
  readonly providerModule: CompilerModuleIdentity;
  readonly reason: 'array-identity';
}

export interface CompilerRustModuleConstantModulePlan {
  readonly bindings: readonly CompilerRustModuleConstantBindingPlan[];
  readonly importRefusals: readonly CompilerRustModuleArrayImportRefusal[];
  readonly module: CompilerModuleIdentity;
  readonly refusals: readonly CompilerRustModuleConstantRefusal[];
}

export interface CompilerRustModuleConstantPlan {
  readonly modules: readonly CompilerRustModuleConstantModulePlan[];
  readonly schema: 'flight-rust-module-constant-plan/1';
}

export interface CompilerRustModuleConstantPlanInput {
  readonly moduleResolution?: Readonly<CompilerModuleResolutionPlan> | undefined;
  readonly modules: readonly Readonly<IrModule>[];
}

export interface CompilerRustModuleConstantRefusal {
  readonly bindingId: string;
  readonly code: 'rust-module-array-value-unrepresented' | 'rust-module-constant-initializer-unsupported';
  readonly declarationPath: CompilerIrTraversalPath;
  readonly message: string;
  readonly reason:
    | 'array-identity'
    | 'declared-type'
    | 'dependency-cycle'
    | 'dependency-not-earlier'
    | 'dependency-refused'
    | 'import-not-exact'
    | 'non-finite-number'
    | 'operator-domain'
    | 'unsupported-expression';
}
