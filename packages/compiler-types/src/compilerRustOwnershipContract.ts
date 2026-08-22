import type { IrBindingIdentity } from './compilerBindingIntermediateRepresentation.js';
import type { CompilerModuleIdentity } from './compilerSourceIdentity.js';
import type { CompilerIrTraversalPath } from './compilerTraversalObserverContract.js';
import type { IrType } from './compilerTypeIntermediateRepresentation.js';

export type CompilerRustOwnershipBoundary =
  | 'closureCapture'
  | 'statementValueCarrier'
  | 'structuralRecord'
  | 'suspension';

export interface CompilerRustOwnershipUseEvidence {
  readonly kind: 'read' | 'rebind' | 'referentMutation';
  readonly path: CompilerIrTraversalPath;
}

export interface CompilerRustOwnershipBindingEvidence {
  readonly binding: IrBindingIdentity;
  readonly boundaries: readonly CompilerRustOwnershipBoundary[];
  readonly declaration: 'immutable' | 'mutable' | 'parameter';
  readonly mutation: 'bindingAndReferent' | 'bindingReassigned' | 'none' | 'referentMutated';
  readonly reuse: 'multiple' | 'single' | 'unused';
  readonly storage: 'indeterminate' | 'sharedIdentity' | 'valueSemantic';
  readonly type: IrType;
  readonly uses: readonly CompilerRustOwnershipUseEvidence[];
}

export interface CompilerRustOwnershipEvidence {
  readonly bindings: readonly CompilerRustOwnershipBindingEvidence[];
  readonly module: CompilerModuleIdentity;
  readonly schema: 'flight-compiler-rust-ownership-evidence/1';
}
