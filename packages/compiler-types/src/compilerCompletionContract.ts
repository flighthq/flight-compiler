export type CompilerCompletion =
  | Readonly<{ kind: 'break'; target?: string | undefined }>
  | Readonly<{ kind: 'continue'; target?: string | undefined }>
  | Readonly<{ kind: 'normal' }>
  | Readonly<{ kind: 'return' }>
  | Readonly<{ kind: 'throw' }>;

export type CompilerCompletionKind = CompilerCompletion['kind'];

export interface CompilerCompletionSet {
  readonly completions: readonly CompilerCompletion[];
  readonly schema: 'flight-compiler-completion-set/1';
}

export type CompilerCompletionFailureCode =
  | 'invalid-completion'
  | 'invalid-completion-set'
  | 'invalid-completion-target';

export interface CompilerCompletionFailure extends Error {
  readonly code: CompilerCompletionFailureCode;
  readonly kind: 'compiler-completion';
  readonly path: readonly (number | string)[];
}
