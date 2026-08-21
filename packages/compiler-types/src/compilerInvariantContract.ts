export type CompilerInvariantCode =
  | 'duplicate-emitted-path'
  | 'duplicate-module-identity'
  | 'duplicate-target-name-identity'
  | 'insufficient-emitted-source-syntax-files'
  | 'insufficient-target-compilation-smoke-files'
  | 'invalid-generated-file-provenance'
  | 'invalid-emitted-source-parser'
  | 'invalid-emitted-source-syntax-diagnostic'
  | 'invalid-target-compilation-smoke-adapter'
  | 'invalid-target-compilation-smoke-diagnostic'
  | 'invalid-target-name-candidate'
  | 'unsafe-emitted-contents'
  | 'unsafe-emitted-path';

export interface CompilerInvariantFailure extends Error {
  readonly code: CompilerInvariantCode;
  readonly kind: 'compiler-invariant';
  readonly subject: string;
}
