export type CompilerIrModuleValidationFailureCode =
  | 'dangling-binding-reference'
  | 'duplicate-binding-identity'
  | 'inconsistent-binding-reference'
  | 'invalid-binding-identity'
  | 'invalid-binding-origin'
  | 'invalid-compound-type-arity'
  | 'invalid-module-identity'
  | 'invalid-node-shape'
  | 'invalid-parameter-cardinality'
  | 'unknown-ir-kind';

export interface CompilerIrModuleValidationFailure {
  readonly code: CompilerIrModuleValidationFailureCode;
  readonly path: string;
  readonly reason: string;
}

export type CompilerIrModuleValidation =
  | Readonly<{ kind: 'valid' }>
  | Readonly<{
      failures: readonly CompilerIrModuleValidationFailure[];
      kind: 'invalid';
    }>;
