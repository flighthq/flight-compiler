import type { CompilerModuleEvaluationPlan } from './compilerModuleEvaluationContract.js';
import type {
  CompilerRustModuleEvaluationLocator,
  CompilerRustModuleEvaluationRepresentationPlan,
  CompilerRustModuleEvaluationRepresentationRefusal,
} from './compilerRustModuleEvaluationRepresentationContract.js';
import type { CompilerRustPublicCrateIdentity } from './compilerRustPublicBindingContract.js';
import type { CompilerModuleIdentity } from './compilerSourceIdentity.js';

export type CompilerRustModuleEvaluationExecutionAvailability =
  | Readonly<{ outcome: 'available' }>
  | Readonly<{
      outcome: 'refused';
      refusals: readonly CompilerRustModuleEvaluationRepresentationRefusal[];
      subjects: readonly string[];
    }>;

export interface CompilerRustModuleEvaluationExecutionEntryPlan {
  readonly crate: CompilerRustPublicCrateIdentity;
  readonly groupIndex: number;
  readonly locator: CompilerRustModuleEvaluationLocator;
  readonly module: CompilerModuleIdentity;
}

export interface CompilerRustModuleEvaluationExecutionFunctionPlan<Spelling extends string> {
  readonly signature: Readonly<{
    parameters: readonly [];
    result: 'Result<(), FlightModuleEvaluationError>';
  }>;
  readonly spelling: Spelling;
  readonly visibility: 'crate';
}

export interface CompilerRustModuleEvaluationExecutionModulePlan {
  readonly crate: CompilerRustPublicCrateIdentity;
  readonly groupIndex: number;
  readonly lifecycle: Readonly<{
    evaluate: CompilerRustModuleEvaluationExecutionFunctionPlan<'__flight_evaluate_once'>;
    instantiate: CompilerRustModuleEvaluationExecutionFunctionPlan<'__flight_instantiate_once'>;
    state: Readonly<{
      spelling: '__flight_module_evaluation_state';
      states: readonly ['uninstantiated', 'instantiating', 'instantiated', 'evaluating', 'evaluated', 'errored'];
      visibility: 'private';
    }>;
  }>;
  readonly locator: CompilerRustModuleEvaluationLocator;
  readonly module: CompilerModuleIdentity;
}

export interface CompilerRustModuleEvaluationInvocationPlan {
  readonly crate: CompilerRustPublicCrateIdentity;
  readonly cyclic: boolean;
  readonly groupIndex: number;
  readonly locator: Readonly<{
    modulePath: readonly [];
    spelling: `__flight_${'evaluate' | 'instantiate'}_group_${number}`;
    visibility: 'public-doc-hidden';
  }>;
  readonly modules: readonly CompilerModuleIdentity[];
  readonly signature: Readonly<{
    parameters: readonly [];
    result: 'Result<(), FlightModuleEvaluationError>';
  }>;
}

export interface CompilerRustModuleEvaluationExecutionPlan {
  readonly availability: CompilerRustModuleEvaluationExecutionAvailability;
  readonly entries: readonly CompilerRustModuleEvaluationExecutionEntryPlan[];
  readonly error: Readonly<{
    crateName: string;
    result: 'Result<(), FlightModuleEvaluationError>';
    targetName: 'FlightModuleEvaluationError';
  }>;
  /** Modules present in neutral evaluation groups; linked type-only modules have no lifecycle hook. */
  readonly modules: readonly CompilerRustModuleEvaluationExecutionModulePlan[];
  readonly phases: readonly [
    Readonly<{
      invocations: readonly CompilerRustModuleEvaluationInvocationPlan[];
      kind: 'instantiate';
    }>,
    Readonly<{
      invocations: readonly CompilerRustModuleEvaluationInvocationPlan[];
      kind: 'evaluate';
    }>,
  ];
  readonly publicBindingSchema: 'flight-rust-public-binding-plan/3';
  readonly representationSchema: 'flight-rust-module-evaluation-representation-plan/1';
  readonly runtimeAbiSchema: 'flight-rust-runtime-abi/4';
  readonly schema: 'flight-rust-module-evaluation-execution-plan/1';
  readonly semantics: Readonly<{
    concurrency: 'serialized-by-bootstrap';
    facadeAccess: 'successful-bootstrap-before-value-access';
    failure: 'cache-first-error-stop-without-retry';
    groupOrder: 'flight-compiler-module-evaluation/1';
    phaseOrder: readonly ['instantiate', 'evaluate'];
    reentrancy: 'reject';
    repeatedInvocation: 'cache-first-result';
    reservedNamespace: '__flight_';
  }>;
}

export type CompilerRustModuleEvaluationExecutionRepresentationProjection =
  | Readonly<{
      kind: 'output-scope-incomplete';
      refusal: CompilerRustModuleEvaluationRepresentationRefusal;
      subjects: readonly string[];
    }>
  | Readonly<{
      kind: 'plan';
      plan: CompilerRustModuleEvaluationRepresentationPlan;
    }>;

export interface CompilerRustModuleEvaluationExecutionPlanInput {
  readonly moduleEvaluation: CompilerModuleEvaluationPlan;
  readonly representation: CompilerRustModuleEvaluationExecutionRepresentationProjection;
  readonly runtimeCrate?: string | undefined;
}

export type CompilerRustModuleEvaluationExecutionPlanningFailureCode =
  | 'rust-module-evaluation-execution-entry-refusal-duplicate'
  | 'rust-module-evaluation-execution-entry-refusal-missing'
  | 'rust-module-evaluation-execution-entry-refusal-non-entry'
  | 'rust-module-evaluation-execution-invalid-input'
  | 'rust-module-evaluation-execution-projection-mismatch'
  | 'rust-module-evaluation-execution-reserved-name-collision';

export interface CompilerRustModuleEvaluationExecutionPlanningFailure extends Error {
  readonly code: CompilerRustModuleEvaluationExecutionPlanningFailureCode;
  readonly kind: 'rust-module-evaluation-execution-planning';
  readonly subjects: readonly string[];
}
