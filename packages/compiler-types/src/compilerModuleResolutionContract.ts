import type { CompilerModuleIdentity, CompilerSourceIdentity } from './compilerSourceIdentity.js';

export interface CompilerModuleResolutionEdge {
  /** Absent means a workspace-wide package export; present means one importer's exact request. */
  readonly importer?: CompilerModuleIdentity | undefined;
  readonly specifier: string;
  readonly target: CompilerSourceIdentity;
}

export interface CompilerModuleResolutionPlan {
  readonly edges: readonly CompilerModuleResolutionEdge[];
  readonly schema: 'flight-compiler-module-resolution/1';
}

export type CompilerModuleResolutionFailureCode =
  | 'duplicate-package-specifier'
  | 'invalid-inventory'
  | 'invalid-package-export-lane';

export interface CompilerModuleResolutionFailure extends Error {
  readonly code: CompilerModuleResolutionFailureCode;
  readonly kind: 'compiler-module-resolution';
  readonly subject: string;
}
