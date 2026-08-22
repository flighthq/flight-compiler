export type CompilerStatementCompletionFailureCode =
  | 'invalid-control-flow-label'
  | 'invalid-statement-list'
  | 'unknown-statement-kind';

export interface CompilerStatementCompletionFailure extends Error {
  readonly code: CompilerStatementCompletionFailureCode;
  readonly kind: 'compiler-statement-completion';
  readonly path: readonly (number | string)[];
}
