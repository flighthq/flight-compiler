export type CompilerCatchBindingPresence = 'absent' | 'present';

export type CompilerCatchBindingInitialization =
  | Readonly<{ kind: 'discard' }>
  | Readonly<{ kind: 'initialize'; source: 'thrown-value'; timing: 'before-body' }>;

export interface IrCatchSemantics {
  readonly bindingInitialization: CompilerCatchBindingInitialization;
  readonly bodyExecution: 'once-per-caught-throw';
  readonly catchCompletion: 'propagate';
  readonly interceptedCompletion: 'throw';
  readonly schema: 'flight-compiler-catch-semantics/1';
  readonly uncaughtCompletion: 'preserve';
}

export type CompilerCatchCompletionFailureCode = 'invalid-binding-presence';

export interface CompilerCatchCompletionFailure extends Error {
  readonly code: CompilerCatchCompletionFailureCode;
  readonly kind: 'compiler-catch-completion';
  readonly path: readonly (number | string)[];
}
