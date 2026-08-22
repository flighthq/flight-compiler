import type { IrBindingIdentity } from './compilerBindingIntermediateRepresentation.js';
import type { IrModule } from './compilerModuleIntermediateRepresentation.js';
import type { CompilerModuleIdentity } from './compilerSourceIdentity.js';
import type { CompilerIrTraversalPath } from './compilerTraversalObserverContract.js';

export interface CompilerModuleEvaluationDependency {
  readonly importer: CompilerModuleIdentity;
  readonly specifier: string;
  readonly target: CompilerModuleIdentity;
}

export interface CompilerModuleEvaluationInput {
  readonly dependencies: readonly CompilerModuleEvaluationDependency[];
  readonly entries: readonly CompilerModuleIdentity[];
  readonly modules: readonly Readonly<IrModule>[];
}

export type CompilerModuleEvaluationBinding =
  | Readonly<{
      access: 'dependency-live';
      binding: IrBindingIdentity;
      initialization: Readonly<{
        imported: string;
        kind: 'dependency';
        module: CompilerModuleIdentity;
      }>;
      kind: 'import';
      mutation: 'read-only';
    }>
  | Readonly<{
      access: 'available-after-instantiation' | 'temporal-until-evaluation';
      binding: IrBindingIdentity;
      initialization:
        | Readonly<{ kind: 'evaluation'; step: number }>
        | Readonly<{ kind: 'instantiation'; value: 'function' | 'undefined' }>;
      kind: 'local';
      mutation: 'immutable' | 'mutable';
    }>;

export interface CompilerModuleEvaluationStep {
  readonly action: 'assign' | 'initialize';
  readonly bindings: readonly IrBindingIdentity[];
  readonly completion: 'abrupt-stops-module-evaluation';
  readonly declaration: 'class' | 'defaultExpression' | 'enum' | 'variable';
  readonly path: CompilerIrTraversalPath;
}

export interface CompilerModuleEvaluationModulePlan {
  readonly bindings: readonly CompilerModuleEvaluationBinding[];
  readonly dependencies: readonly CompilerModuleEvaluationDependency[];
  readonly module: CompilerModuleIdentity;
  readonly steps: readonly CompilerModuleEvaluationStep[];
}

export interface CompilerModuleEvaluationGroup {
  readonly cyclic: boolean;
  readonly modules: readonly CompilerModuleIdentity[];
}

export interface CompilerModuleEvaluationSemantics {
  readonly cycles: 'strongly-connected-live-environment';
  readonly dependencyEvaluation: 'depth-first-request-order';
  readonly importAccess: 'read-only-live-alias';
  readonly localExportAccess: 'live-alias';
  readonly phaseOrder: readonly ['link', 'instantiate', 'evaluate-dependencies', 'evaluate'];
  readonly temporalAccess: 'throw-reference-error';
  readonly topLevelAwait: 'refuse';
}

export interface CompilerModuleEvaluationPlan {
  readonly entries: readonly CompilerModuleIdentity[];
  readonly groups: readonly CompilerModuleEvaluationGroup[];
  readonly modules: readonly CompilerModuleEvaluationModulePlan[];
  readonly schema: 'flight-compiler-module-evaluation/1';
  readonly semantics: CompilerModuleEvaluationSemantics;
}

export type CompilerModuleEvaluationFailureCode =
  | 'duplicate-binding'
  | 'duplicate-dependency'
  | 'duplicate-entry'
  | 'duplicate-module'
  | 'invalid-declaration-kind'
  | 'invalid-dependency'
  | 'invalid-entry'
  | 'invalid-module'
  | 'missing-dependency'
  | 'top-level-await'
  | 'unexpected-dependency'
  | 'unreachable-module'
  | 'unsupported-default-expression-order';

export interface CompilerModuleEvaluationFailure extends Error {
  readonly code: CompilerModuleEvaluationFailureCode;
  readonly kind: 'compiler-module-evaluation';
  readonly module?: CompilerModuleIdentity | undefined;
  readonly subject: string;
}
