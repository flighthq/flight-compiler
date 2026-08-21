import type { CompilerIrTraversalPath } from './compilerTraversalObserverContract.js';
import type { IrType, IrTypeParameter } from './compilerTypeIntermediateRepresentation.js';

export interface CompilerStructuralTypeSubstitution {
  readonly parameter: IrTypeParameter['binding'];
  readonly type: IrType;
}

export interface CompilerStructuralTypeSubstitutionPlan {
  readonly schema: 'flight-compiler-structural-type-substitution/1';
  readonly substitutions: readonly CompilerStructuralTypeSubstitution[];
}

export type CompilerStructuralTypeSubstitutionFailureCode =
  | 'cyclic-type-substitution'
  | 'duplicate-type-parameter'
  | 'invalid-substitution-plan'
  | 'invalid-type-parameter-reference'
  | 'missing-type-argument'
  | 'too-many-type-arguments';

export interface CompilerStructuralTypeSubstitutionFailure extends Error {
  readonly code: CompilerStructuralTypeSubstitutionFailureCode;
  readonly kind: 'compiler-structural-type-substitution';
  readonly path: CompilerIrTraversalPath;
}
