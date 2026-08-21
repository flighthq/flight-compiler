import type { CompilerModuleIdentity } from './compilerSourceIdentity.js';
import type { CompilerIrTraversalPath } from './compilerTraversalObserverContract.js';

export type CompilerStructuralTypeShapeIdentity = `flight-structural-type-shape/1:${string}`;

export type CompilerStructuralTypeShapeFailureCode = 'cyclic-type' | 'duplicate-object-property' | 'non-finite-literal';

export interface CompilerStructuralTypeShapeFailure extends Error {
  readonly code: CompilerStructuralTypeShapeFailureCode;
  readonly kind: 'compiler-structural-type-shape';
  readonly path: CompilerIrTraversalPath;
}

export interface CompilerStructuralTypeShapeOccurrence extends CompilerModuleIdentity {
  readonly path: CompilerIrTraversalPath;
}

export interface CompilerStructuralTypeShape {
  readonly identity: CompilerStructuralTypeShapeIdentity;
  readonly occurrences: readonly CompilerStructuralTypeShapeOccurrence[];
}

export interface CompilerStructuralTypeShapeInventory {
  readonly modules: number;
  readonly schema: 'flight-compiler-structural-type-shapes/1';
  readonly shapes: readonly CompilerStructuralTypeShape[];
}
