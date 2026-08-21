export type CompilerInvariantCode =
  | 'duplicate-emitted-path'
  | 'duplicate-module-identity'
  | 'duplicate-target-name-identity'
  | 'insufficient-source-conformance-files'
  | 'invalid-generated-file-provenance'
  | 'invalid-source-conformance-diagnostic'
  | 'invalid-source-conformance-parser'
  | 'invalid-target-name-candidate'
  | 'unsafe-emitted-contents'
  | 'unsafe-emitted-path';

export interface CompilerInvariantFailure extends Error {
  readonly code: CompilerInvariantCode;
  readonly kind: 'compiler-invariant';
  readonly subject: string;
}
