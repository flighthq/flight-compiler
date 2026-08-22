import type { CompilerIrTraversalPath } from './compilerTraversalObserverContract.js';

export type CompilerStructuralTypeAssignabilityDiagnosticCode =
  | 'callable-parameter-cardinality-incompatible'
  | 'generic-callable-indeterminate'
  | 'missing-required-property'
  | 'named-type-indeterminate'
  | 'optional-member-incompatible'
  | 'readonly-container-incompatible'
  | 'readonly-member-incompatible'
  | 'tuple-cardinality-incompatible'
  | 'type-incompatible'
  | 'type-operator-indeterminate'
  | 'unknown-type-indeterminate'
  | 'union-target-incompatible'
  | 'union-target-indeterminate';

export interface CompilerStructuralTypeAssignabilityDiagnostic {
  readonly code: CompilerStructuralTypeAssignabilityDiagnosticCode;
  readonly disposition: 'incompatible' | 'indeterminate';
  readonly message: string;
  readonly path: CompilerIrTraversalPath;
}

export interface CompilerStructuralTypeAssignabilityReport {
  readonly diagnostics: readonly CompilerStructuralTypeAssignabilityDiagnostic[];
  readonly schema: 'flight-compiler-structural-type-assignability/1';
  readonly status: 'compatible' | 'incompatible' | 'indeterminate';
}

export type CompilerStructuralTypeAssignabilityFailureCode = 'cyclic-type' | 'duplicate-object-property';

export interface CompilerStructuralTypeAssignabilityFailure extends Error {
  readonly code: CompilerStructuralTypeAssignabilityFailureCode;
  readonly kind: 'compiler-structural-type-assignability';
  readonly path: CompilerIrTraversalPath;
}
