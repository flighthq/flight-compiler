import type { CompilerRustModuleEvaluationExecutionAvailability } from './compilerRustModuleEvaluationExecutionContract.js';
import type { CompilerRustPublicCrateIdentity } from './compilerRustPublicBindingContract.js';
import type { CompilerModuleIdentity } from './compilerSourceIdentity.js';

export type CompilerRustModuleEvaluationEmissionAvailability = CompilerRustModuleEvaluationExecutionAvailability;

export type CompilerRustModuleEvaluationEmissionLocator =
  | Readonly<{
      crate: CompilerRustPublicCrateIdentity;
      /** Present when the crate-root fragment also owns a root module lifecycle. */
      filePath?: string | undefined;
      kind: 'crate-root';
      modulePath: readonly [];
      packageName: string;
    }>
  | Readonly<{
      crate: CompilerRustPublicCrateIdentity;
      filePath: string;
      kind: 'module';
      modulePath: readonly [string, ...string[]];
      packageName: string;
    }>;

export type CompilerRustModuleEvaluationEmissionSymbol =
  | Readonly<{
      enumSpelling: '__FlightModuleEvaluationState';
      kind: 'module-state';
      module: CompilerModuleIdentity;
      spelling: '__flight_module_evaluation_state';
      states: readonly ['Uninstantiated', 'Instantiating', 'Instantiated', 'Evaluating', 'Evaluated', 'Errored'];
      visibility: 'private';
    }>
  | Readonly<{
      kind: 'module-lifecycle';
      module: CompilerModuleIdentity;
      phase: 'instantiate' | 'evaluate';
      signature: 'Result<(), FlightModuleEvaluationError>';
      spelling: '__flight_instantiate_once' | '__flight_evaluate_once';
      visibility: 'crate';
    }>
  | Readonly<{
      groupIndex: number;
      kind: 'group-lifecycle';
      modules: readonly CompilerModuleIdentity[];
      phase: 'instantiate' | 'evaluate';
      signature: 'Result<(), FlightModuleEvaluationError>';
      spelling: `__flight_${'instantiate' | 'evaluate'}_group_${number}`;
      visibility: 'public-doc-hidden';
    }>;

export interface CompilerRustModuleEvaluationEmissionFragment {
  readonly locator: CompilerRustModuleEvaluationEmissionLocator;
  /** Declaration order in `source`, with instantiate descriptors before evaluate descriptors. */
  readonly symbols: readonly CompilerRustModuleEvaluationEmissionSymbol[];
  readonly source: string;
}

export interface CompilerRustModuleEvaluationEmissionPlan {
  readonly availability: CompilerRustModuleEvaluationEmissionAvailability;
  readonly error: Readonly<{
    crateName: string;
    result: 'Result<(), FlightModuleEvaluationError>';
    targetName: 'FlightModuleEvaluationError';
  }>;
  readonly executionSchema: 'flight-rust-module-evaluation-execution-plan/1';
  readonly fragments: readonly CompilerRustModuleEvaluationEmissionFragment[];
  readonly runtimeAbiSchema: 'flight-rust-runtime-abi/4';
  readonly schema: 'flight-rust-module-evaluation-emission-plan/1';
}

export type CompilerRustModuleEvaluationEmissionPlanningFailureCode =
  | 'rust-module-evaluation-emission-invalid-input'
  | 'rust-module-evaluation-emission-projection-mismatch';

export interface CompilerRustModuleEvaluationEmissionPlanningFailure extends Error {
  readonly code: CompilerRustModuleEvaluationEmissionPlanningFailureCode;
  readonly kind: 'rust-module-evaluation-emission-planning';
  readonly subjects: readonly string[];
}
