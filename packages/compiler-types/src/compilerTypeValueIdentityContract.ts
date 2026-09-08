import type { IrModule } from './compilerModuleIntermediateRepresentation.js';
import type { IrType } from './compilerTypeIntermediateRepresentation.js';

export type CompilerTypeValueIdentity = 'indeterminate' | 'reference' | 'value';

export type CompilerTypeValueIdentityReason =
  | 'ambiguous-compound'
  | 'cyclic-reference'
  | 'declared-reference'
  | 'declared-value'
  | 'homogeneous-compound'
  | 'intrinsic-reference'
  | 'intrinsic-value'
  | 'invalid-type-application'
  | 'known-ambient-reference'
  | 'type-operator'
  | 'unconstrained-type-parameter'
  | 'unknown-type'
  | 'unsupported-ambient-utility'
  | 'unresolved-reference';

export interface CompilerTypeValueIdentityAnalysis {
  readonly identity: CompilerTypeValueIdentity;
  readonly reason: CompilerTypeValueIdentityReason;
  readonly schema: 'flight-compiler-type-value-identity/1';
}

export interface CompilerTypeValueIdentityAnalyzer {
  readonly analyze: (type: Readonly<IrType>, module: Readonly<IrModule>) => CompilerTypeValueIdentityAnalysis;
  readonly schema: 'flight-compiler-type-value-identity-analyzer/1';
}
