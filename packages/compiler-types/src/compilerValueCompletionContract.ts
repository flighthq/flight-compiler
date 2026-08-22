import type { CompilerCompletionKind } from './compilerCompletionContract.js';
import type { CompilerIrTraversalPath } from './compilerTraversalObserverContract.js';

export type CompilerCompletionValueSource =
  | Readonly<{ kind: 'empty' }>
  | Readonly<{
      kind: 'expression';
      path: CompilerIrTraversalPath;
      phase: 'abrupt' | 'result';
    }>
  | Readonly<{ kind: 'implicitUndefined' }>;

export type CompilerValueCompletionPath = Readonly<{
  kind: CompilerCompletionKind;
  path: CompilerIrTraversalPath;
  value: CompilerCompletionValueSource;
}> &
  (
    | Readonly<{ kind: 'break' | 'continue'; target?: string | undefined }>
    | Readonly<{ kind: 'normal' | 'return' | 'throw'; target?: never }>
  );

export interface CompilerValueCompletionPathSet {
  readonly paths: readonly CompilerValueCompletionPath[];
  readonly schema: 'flight-compiler-value-completion-path-set/1';
}

export interface CompilerValueCompletionCatchInterception {
  readonly path: CompilerIrTraversalPath;
  readonly value: CompilerCompletionValueSource;
}

export interface CompilerValueCompletionCatchReplacement {
  readonly completions: CompilerValueCompletionPathSet;
  readonly interceptions: readonly CompilerValueCompletionCatchInterception[];
  readonly schema: 'flight-compiler-value-completion-catch-replacement/1';
}

export type CompilerValueCompletionFailureCode =
  | 'invalid-completion-kind'
  | 'invalid-completion-path'
  | 'invalid-completion-target'
  | 'invalid-completion-value'
  | 'invalid-path-set';

export interface CompilerValueCompletionFailure extends Error {
  readonly code: CompilerValueCompletionFailureCode;
  readonly kind: 'compiler-value-completion';
  readonly path: readonly (number | string)[];
}
