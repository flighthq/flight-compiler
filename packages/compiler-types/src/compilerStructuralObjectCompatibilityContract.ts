import type { CompilerModuleIdentity } from './compilerSourceIdentity.js';
import type { CompilerIrTraversalPath } from './compilerTraversalObserverContract.js';

export type CompilerStructuralObjectCompatibilityDiagnostic = Readonly<{
  code: CompilerStructuralObjectCompatibilityDiagnosticCode;
  disposition: CompilerStructuralObjectCompatibilityDisposition;
  message: string;
  path: CompilerIrTraversalPath;
  property?: string | undefined;
}>;

export type CompilerStructuralObjectCompatibilityDiagnosticCode =
  | 'ambiguous-named-construction-target'
  | 'computed-property-indeterminate'
  | 'cyclic-construction-target'
  | 'duplicate-property-requires-normalization'
  | 'invalid-type-application'
  | 'missing-required-property'
  | 'non-structural-construction-target'
  | 'open-construction-target'
  | 'spread-membership-indeterminate'
  | 'unknown-property'
  | 'unresolved-named-construction-target';

export type CompilerStructuralObjectCompatibilityDisposition = 'incompatible' | 'indeterminate' | 'requires-lowering';

export interface CompilerStructuralObjectCompatibilityReport {
  readonly diagnostics: readonly CompilerStructuralObjectCompatibilityDiagnostic[];
  readonly module: CompilerModuleIdentity;
  readonly schema: 'flight-compiler-structural-object-compatibility/1';
  readonly status: 'compatible' | 'incompatible' | 'indeterminate';
}
