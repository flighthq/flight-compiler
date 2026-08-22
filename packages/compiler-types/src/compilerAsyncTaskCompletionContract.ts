export type CompilerAsyncTaskSettlement =
  | Readonly<{ kind: 'reject'; source: 'thrown-value' }>
  | Readonly<{ kind: 'resolve'; source: 'implicit-undefined' | 'return-value' }>;

export interface CompilerAsyncTaskCompletionPlan {
  readonly bodyStart: 'synchronous-until-suspension';
  readonly resolution: 'normalize-value-task-or-thenable';
  readonly schema: 'flight-compiler-async-task-completion/1';
  readonly settlements: readonly CompilerAsyncTaskSettlement[];
  readonly taskCreation: 'before-body';
}

export type CompilerAsyncTaskCompletionFailureCode = 'escaping-control-flow';

export interface CompilerAsyncTaskCompletionFailure extends Error {
  readonly code: CompilerAsyncTaskCompletionFailureCode;
  readonly completion: 'break' | 'continue';
  readonly kind: 'compiler-async-task-completion';
  readonly path: readonly (number | string)[];
  readonly target?: string | undefined;
}

export interface IrAwaitSemantics {
  readonly continuation: 'enqueue-after-settlement';
  readonly fulfillment: 'resume-normal-with-value';
  readonly operandEvaluation: 'once-before-suspension';
  readonly rejection: 'resume-throw-with-reason';
  readonly schema: 'flight-compiler-await-semantics/1';
  readonly suspension: 'always-before-continuation';
  readonly taskResolution: 'normalize-value-task-or-thenable';
}
