import type { IrBindingIdentity, IrTypeBindingIdentity } from './compilerBindingIntermediateRepresentation.js';
import type { CompilerModuleEvaluationPlan } from './compilerModuleEvaluationContract.js';
import type { IrModule } from './compilerModuleIntermediateRepresentation.js';
import type { CompilerModuleIdentity } from './compilerSourceIdentity.js';
import type { CompilerIrTraversalPath } from './compilerTraversalObserverContract.js';

export type CompilerModuleFacadeLane = 'type' | 'value';

export type CompilerModuleFacadeSource =
  | Readonly<{ bindingId: string; kind: 'local-binding' }>
  | Readonly<{ kind: 'local-expression' }>
  | Readonly<{ kind: 'module-all'; specifier: string }>
  | Readonly<{ imported: string; kind: 'module-binding'; specifier: string }>
  | Readonly<{ kind: 'module-namespace'; specifier: string }>;

export interface CompilerModuleFacadeIdentity {
  readonly exportName: string;
  readonly identity: string;
  readonly lane: CompilerModuleFacadeLane;
  readonly module: CompilerModuleIdentity;
  readonly source: CompilerModuleFacadeSource;
}

export interface CompilerModuleFacadeInput {
  readonly evaluation: CompilerModuleEvaluationPlan;
  readonly modules: readonly Readonly<IrModule>[];
}

export interface CompilerModuleFacadeHop {
  readonly kind: 'import' | 'named-reexport' | 'namespace-reexport' | 'star-reexport';
  readonly module: CompilerModuleIdentity;
  readonly specifier: string;
  readonly target: CompilerModuleIdentity;
}

export type CompilerModuleFacadeRoute =
  | Readonly<{
      binding: IrBindingIdentity | IrTypeBindingIdentity;
      kind: 'binding';
      module: CompilerModuleIdentity;
    }>
  | Readonly<{
      kind: 'expression';
      module: CompilerModuleIdentity;
      path: CompilerIrTraversalPath;
    }>
  | Readonly<{ kind: 'namespace'; module: CompilerModuleIdentity }>;

export interface CompilerModuleFacadeSlot extends CompilerModuleFacadeIdentity {
  readonly route: CompilerModuleFacadeRoute;
  readonly via: readonly CompilerModuleFacadeHop[];
}

export interface CompilerModuleFacadeModulePlan {
  readonly module: CompilerModuleIdentity;
  readonly slots: readonly CompilerModuleFacadeSlot[];
}

export interface CompilerModuleFacadeSemantics {
  readonly bindingAccess: 'live';
  readonly explicitPrecedence: 'named-over-star';
  readonly starAmbiguity: 'refuse-distinct-resolutions';
  readonly starDefault: 'excluded';
  readonly typeValueLanes: 'independent';
}

export interface CompilerModuleFacadePlan {
  readonly modules: readonly CompilerModuleFacadeModulePlan[];
  readonly schema: 'flight-compiler-module-facade/1';
  readonly semantics: CompilerModuleFacadeSemantics;
}

export type CompilerModuleFacadeFailureCode =
  | 'ambiguous-facade-star'
  | 'duplicate-facade-identity'
  | 'invalid-facade-evaluation'
  | 'invalid-facade-export'
  | 'invalid-facade-module'
  | 'missing-facade-binding'
  | 'missing-facade-dependency'
  | 'missing-facade-export'
  | 'mismatched-facade-module';

export interface CompilerModuleFacadeFailure extends Error {
  readonly code: CompilerModuleFacadeFailureCode;
  readonly kind: 'compiler-module-facade';
  readonly subject: string;
}
