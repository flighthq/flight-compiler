import type { IrModule } from './compilerModuleIntermediateRepresentation.js';
import type { CompilerModuleResolutionPlan } from './compilerModuleResolutionContract.js';
import type { CompilerModuleIdentity } from './compilerSourceIdentity.js';
import type { CompilerIrTraversalPath } from './compilerTraversalObserverContract.js';

export interface CompilerRustModuleStateBindingPlan {
  readonly bindingId: string;
  readonly declarationPath: CompilerIrTraversalPath;
  readonly initializer: boolean | number;
  readonly scalar: 'boolean' | 'number';
  readonly update: 'none' | 'number-increment-decrement';
}

export interface CompilerRustModuleStateModulePlan {
  readonly bindings: readonly CompilerRustModuleStateBindingPlan[];
  readonly module: CompilerModuleIdentity;
}

export interface CompilerRustModuleStatePlan {
  readonly modules: readonly CompilerRustModuleStateModulePlan[];
  readonly schema: 'flight-rust-module-state-plan/1';
}

export interface CompilerRustModuleStatePlanInput {
  readonly moduleResolution?: Readonly<CompilerModuleResolutionPlan> | undefined;
  readonly modules: readonly Readonly<IrModule>[];
}
