import type { IrBindingIdentity } from './compilerBindingIntermediateRepresentation.js';
import type { CompilerModuleIdentity } from './compilerSourceIdentity.js';
import type { CompilerIrTraversalPath } from './compilerTraversalObserverContract.js';
import type { IrType } from './compilerTypeIntermediateRepresentation.js';

export type CompilerAsyncTaskLexicalOrigin =
  | Readonly<{ binding: IrBindingIdentity; kind: 'functionDeclaration' }>
  | Readonly<{
      classBinding: IrBindingIdentity;
      kind: 'classMethod';
      method: string;
      static: boolean;
    }>
  | Readonly<{
      binding?: IrBindingIdentity | undefined;
      kind: 'functionExpression';
    }>;

export type CompilerAsyncTaskOutput =
  | Readonly<{
      kind: 'recovered';
      source: 'ambient-promise-type-argument';
      type: IrType;
    }>
  | Readonly<{
      declaredType: IrType;
      kind: 'unresolved';
    }>;

export interface CompilerAsyncTaskScope {
  readonly body: 'block' | 'expression';
  readonly origin: CompilerAsyncTaskLexicalOrigin;
  readonly output: CompilerAsyncTaskOutput;
  readonly path: CompilerIrTraversalPath;
  readonly taskCreation: 'before-body';
}

export interface CompilerAsyncTaskSuspensionSite {
  readonly kind: 'asyncIteration' | 'await';
  readonly path: CompilerIrTraversalPath;
  readonly scopePath?: CompilerIrTraversalPath | undefined;
}

export type CompilerAsyncTaskOperationIdentity =
  | Readonly<{ evidence: 'ambient-promise-constructor'; operation: 'construct' }>
  | Readonly<{ evidence: 'ambient-promise-static'; operation: 'joinAll' | 'ready' | 'reject' }>
  | Readonly<{ evidence: 'async-binding' | 'inline-async-function'; operation: 'invokeAsync' }>
  | Readonly<{ evidence: 'property-name-candidate'; operation: 'catch' | 'finally' | 'then' }>;

export type CompilerAsyncTaskOperation = CompilerAsyncTaskOperationIdentity &
  Readonly<{
    argumentCount: number | 'dynamic';
    optional: boolean;
    path: CompilerIrTraversalPath;
    scopePath?: CompilerIrTraversalPath | undefined;
  }>;

export interface CompilerAsyncTaskInventory {
  readonly module: CompilerModuleIdentity;
  readonly operations: readonly CompilerAsyncTaskOperation[];
  readonly schema: 'flight-compiler-async-task-inventory/1';
  readonly scopes: readonly CompilerAsyncTaskScope[];
  readonly suspensions: readonly CompilerAsyncTaskSuspensionSite[];
}
